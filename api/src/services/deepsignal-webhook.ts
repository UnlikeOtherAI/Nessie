import type { PrismaClient } from '@prisma/client'
import type { DeepSignalSignalKind } from '@nessie/schemas'

import { ensureDefaultThread } from './channel-records.js'
import {
  deliverInsightToDigest,
  type DigestDeliveryMode,
  type InsightSummary,
  type SignalDigestOptions,
} from './deepsignal-digest.js'
import { externalAgentDmKey } from './external-agent.js'

/**
 * DeepSignal proactive-insight fan-out (integration plan §6, delivery shaping
 * from deep-integration research §3).
 *
 * The webhook receiver verifies the HMAC + resolves the target org; this module
 * turns one verified `insight.surfaced` event into a *coalesced* rolling digest
 * per recipient's DeepSignal channel rather than one card per event. Idempotent
 * per insight (the id is retained on the digest message), and budgeted so a burst
 * of insights cannot firehose a user's channel. Framework-free + I/O-only-via-
 * Prisma so fan-out, coalescing, and budgeting are unit-testable without a running
 * server. Realtime notification is the route's concern — this returns what it did.
 */

export const DEEPSIGNAL_SLUG = 'deepsignal'

export type InsightDelivery = {
  channelId: string
  threadId: string
  messageId: string
  agentId: string | null
  mode: DigestDeliveryMode
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

const externalSubs = (payload: Record<string, unknown>): string[] => {
  const raw = payload.recipientSubs ?? payload.recipient_subs ?? payload.recipients
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

const insightHeadline = (payload: Record<string, unknown>): string => {
  const brief = isRecord(payload.brief) ? payload.brief : {}
  return (
    firstString(brief, ['whatChanged', 'headline', 'title']) ??
    firstString(payload, ['headline', 'title']) ??
    'New insight surfaced'
  )
}

const insightKind = (payload: Record<string, unknown>): DeepSignalSignalKind | null => {
  const brief = isRecord(payload.brief) ? payload.brief : {}
  const value = (
    firstString(brief, ['kind', 'type', 'category']) ??
    firstString(payload, ['kind', 'type', 'category']) ??
    ''
  ).toLowerCase()
  if (['opportunity', 'opportunities'].includes(value)) return 'opportunity'
  if (['risk', 'risks', 'threat'].includes(value)) return 'risk'
  if (value === 'signal') return 'signal'
  return null
}

const resolveInsightId = (payload: Record<string, unknown>): string | null => {
  const brief = isRecord(payload.brief) ? payload.brief : {}
  return firstString(payload, ['insightId', 'insight_id']) ?? firstString(brief, ['insightId', 'insight_id'])
}

type EnabledExternalTeam = {
  externalOrgId: string
  externalTeamId: string
  teamId: string
}

const resolveEnabledExternalTeam = async (
  prisma: PrismaClient,
  organizationId: string,
  payload: Record<string, unknown>,
): Promise<EnabledExternalTeam | null> => {
  const externalTeamId = firstString(payload, ['teamId'])
  if (!externalTeamId) return null

  const enablement = await prisma.productTeamEnablement.findFirst({
    where: {
      enabled: true,
      externalTeamId,
      organizationId,
      productSlug: DEEPSIGNAL_SLUG,
    },
    select: {
      externalOrgId: true,
      externalTeamId: true,
      teamId: true,
      team: {
        select: {
          externalOrgId: true,
          externalWorkspaceId: true,
        },
      },
    },
  })
  if (
    !enablement?.externalOrgId
    || !enablement.externalTeamId
    || enablement.externalTeamId !== externalTeamId
    || enablement.team.externalOrgId !== enablement.externalOrgId
    || enablement.team.externalWorkspaceId !== enablement.externalTeamId
  ) {
    return null
  }

  return {
    externalOrgId: enablement.externalOrgId,
    externalTeamId: enablement.externalTeamId,
    teamId: enablement.teamId,
  }
}

const resolveRecipientUserIds = async (
  prisma: PrismaClient,
  organizationId: string,
  team: EnabledExternalTeam,
  subs: string[],
): Promise<Array<{ activeTeamId: string; userId: string }>> => {
  const links = await prisma.productAccountLink.findMany({
    where: {
      activeOrgId: team.externalOrgId,
      activeTeamId: team.externalTeamId,
      organizationId,
      productSlug: DEEPSIGNAL_SLUG,
      status: 'linked',
      ...(subs.length > 0 ? { uoaSub: { in: subs } } : {}),
      user: {
        organizationMembers: {
          some: { deactivatedAt: null, organizationId },
        },
        teamMembers: {
          some: { teamId: team.teamId },
        },
      },
    },
    select: { activeTeamId: true, userId: true },
  })
  return links.flatMap((link) =>
    link.activeTeamId ? [{ activeTeamId: link.activeTeamId, userId: link.userId }] : [],
  )
}

const deliverToUser = async (
  prisma: PrismaClient,
  organizationId: string,
  recipient: { activeTeamId: string; userId: string },
  insight: InsightSummary,
  options: SignalDigestOptions,
): Promise<InsightDelivery | null> => {
  const dmKey = externalAgentDmKey(
    DEEPSIGNAL_SLUG,
    organizationId,
    recipient.userId,
    recipient.activeTeamId,
  )
  const channel = await prisma.channel.findUnique({
    where: { dmKey },
    select: { id: true, archivedAt: true },
  })
  // A linked user without a live channel (deactivated) is skipped, not created —
  // the channel is re-bootstrapped on their next activation.
  if (!channel || channel.archivedAt) return null

  const threadId = await ensureDefaultThread(prisma, channel.id)
  const binding = await prisma.agentBinding.findFirst({
    where: { channelId: channel.id },
    select: { agentId: true },
  })
  const agentId = binding?.agentId ?? null

  const delivery = await deliverInsightToDigest(prisma, { threadId, agentId, insight }, options)
  return { channelId: channel.id, threadId, messageId: delivery.messageId, agentId, mode: delivery.mode }
}

/**
 * Handle one verified `insight.surfaced` event for a resolved org. Resolves
 * the payload's external team through an exact enabled Nessie/UOA workspace,
 * selects only linked active members of that workspace (narrowed by payload UOA
 * subs when present), and folds the insight into each recipient's rolling
 * digest, coalesced + budgeted. Returns the insight id + what was delivered.
 */
export const handleDeepSignalInsightSurfaced = async (
  prisma: PrismaClient,
  organizationId: string,
  payload: Record<string, unknown>,
  options: SignalDigestOptions = {},
): Promise<InsightFanoutResult> => {
  const insightId = resolveInsightId(payload)
  if (!insightId) return { insightId: null, deliveries: [] }

  const team = await resolveEnabledExternalTeam(prisma, organizationId, payload)
  if (!team) return { insightId, deliveries: [] }

  const recipients = await resolveRecipientUserIds(
    prisma,
    organizationId,
    team,
    externalSubs(payload),
  )
  if (recipients.length === 0) return { insightId, deliveries: [] }

  const insight: InsightSummary = {
    insightId,
    headline: insightHeadline(payload),
    kind: insightKind(payload),
  }

  const deliveries: InsightDelivery[] = []
  for (const recipient of recipients) {
    const delivery = await deliverToUser(
      prisma,
      organizationId,
      recipient,
      insight,
      options,
    )
    if (delivery) deliveries.push(delivery)
  }
  return { insightId, deliveries }
}
