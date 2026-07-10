import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { IntegrationUiCardSchema, type IntegrationUiCard } from '@nessie/schemas'

import { ensureDefaultThread } from './channel-records.js'

/**
 * DeepSignal proactive-insight fan-out (integration plan §6).
 *
 * The webhook receiver verifies the HMAC + resolves the target org; this module
 * turns one verified `insight.surfaced` event into at most one agent-authored
 * message per recipient's DeepSignal channel. Idempotent per insight per channel
 * (`Message.metadata.external.insightId`). Framework-free + I/O-only-via-Prisma so
 * the fan-out + idempotency are unit-testable without a running server. Realtime
 * notification is the route's concern — this returns what it posted.
 */

export const DEEPSIGNAL_SLUG = 'deepsignal'

export type InsightDelivery = {
  channelId: string
  threadId: string
  messageId: string
  agentId: string | null
}

export type InsightFanoutResult = {
  insightId: string | null
  deliveries: InsightDelivery[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const firstString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

const scalarField = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): { label: string; value: string } | null => {
  const value = record[key]
  if (typeof value === 'string' && value.trim().length > 0) return { label, value }
  if (typeof value === 'number' && Number.isFinite(value)) return { label, value: String(value) }
  return null
}

const externalSubs = (payload: Record<string, unknown>): string[] => {
  const raw = payload.recipientSubs ?? payload.recipient_subs ?? payload.recipients
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/** Build the single insight `integration` card from the payload's gated brief. */
const buildInsightCard = (payload: Record<string, unknown>): IntegrationUiCard => {
  const brief = isRecord(payload.brief) ? payload.brief : {}
  const headline =
    firstString(brief, ['whatChanged', 'headline', 'title']) ??
    firstString(payload, ['headline', 'title']) ??
    'New insight'
  const summary = firstString(brief, ['whyItMatters', 'summary', 'recommendedAction']) ?? undefined
  const fields = [
    scalarField(brief, 'recommendedAction', 'Recommended action'),
    scalarField(brief, 'band', 'Priority'),
    scalarField(brief, 'netDirection', 'Direction'),
    scalarField(brief, 'score', 'Score'),
  ].filter((entry): entry is { label: string; value: string } => entry !== null)
  const url = firstString(payload, ['url', 'launchUrl', 'link'])
  const candidate = {
    kind: 'integration' as const,
    productSlug: DEEPSIGNAL_SLUG,
    title: headline,
    status: 'completed' as const,
    ...(summary ? { summary } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(url ? { actions: [{ label: 'Open in DeepSignal', href: url, variant: 'primary' as const }] } : {}),
  }
  // The card is assembled from a closed set of fields; parse to guarantee shape.
  return IntegrationUiCardSchema.parse(candidate)
}

const insightHeadline = (payload: Record<string, unknown>): string => {
  const brief = isRecord(payload.brief) ? payload.brief : {}
  return (
    firstString(brief, ['whatChanged', 'headline', 'title']) ??
    firstString(payload, ['headline', 'title']) ??
    'New insight surfaced'
  )
}

const resolveInsightId = (payload: Record<string, unknown>): string | null => {
  const brief = isRecord(payload.brief) ? payload.brief : {}
  return firstString(payload, ['insightId', 'insight_id']) ?? firstString(brief, ['insightId', 'insight_id'])
}

const resolveRecipientUserIds = async (
  prisma: PrismaClient,
  organizationId: string,
  subs: string[],
): Promise<string[]> => {
  const links = await prisma.productAccountLink.findMany({
    where: {
      organizationId,
      productSlug: DEEPSIGNAL_SLUG,
      status: 'linked',
      ...(subs.length > 0 ? { uoaSub: { in: subs } } : {}),
    },
    select: { userId: true },
  })
  return links.map((link) => link.userId)
}

const postInsightToUser = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
  insightId: string,
  card: IntegrationUiCard,
  headline: string,
): Promise<InsightDelivery | null> => {
  const dmKey = `extagent:${DEEPSIGNAL_SLUG}:${organizationId}:${userId}`
  const channel = await prisma.channel.findUnique({
    where: { dmKey },
    select: { id: true, archivedAt: true },
  })
  // A linked user without a live channel (deactivated) is skipped, not created —
  // the channel is re-bootstrapped on their next activation.
  if (!channel || channel.archivedAt) return null

  const threadId = await ensureDefaultThread(prisma, channel.id)

  // Idempotent per insight per channel: one surfaced message, no duplicates.
  const existing = await prisma.message.findFirst({
    where: { threadId, metadata: { path: ['external', 'insightId'], equals: insightId } },
    select: { id: true },
  })
  if (existing) return null

  const binding = await prisma.agentBinding.findFirst({
    where: { channelId: channel.id },
    select: { agentId: true },
  })

  const message = await prisma.message.create({
    data: {
      agentId: binding?.agentId ?? null,
      threadId,
      role: 'assistant',
      content: headline,
      metadata: {
        uiCards: [card],
        external: { product: DEEPSIGNAL_SLUG, insightId },
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })

  return { channelId: channel.id, threadId, messageId: message.id, agentId: binding?.agentId ?? null }
}

/**
 * Handle one verified `insight.surfaced` event for a resolved org. Resolves
 * recipients (payload UOA subs when present, else every `linked` DeepSignal user
 * in the org) and posts one idempotent insight message into each recipient's
 * channel. Returns the insight id + the messages actually created.
 */
export const handleDeepSignalInsightSurfaced = async (
  prisma: PrismaClient,
  organizationId: string,
  payload: Record<string, unknown>,
): Promise<InsightFanoutResult> => {
  const insightId = resolveInsightId(payload)
  if (!insightId) return { insightId: null, deliveries: [] }

  const userIds = await resolveRecipientUserIds(prisma, organizationId, externalSubs(payload))
  if (userIds.length === 0) return { insightId, deliveries: [] }

  const card = buildInsightCard(payload)
  const headline = insightHeadline(payload)

  const deliveries: InsightDelivery[] = []
  for (const userId of userIds) {
    const delivery = await postInsightToUser(prisma, organizationId, userId, insightId, card, headline)
    if (delivery) deliveries.push(delivery)
  }
  return { insightId, deliveries }
}
