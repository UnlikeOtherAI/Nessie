import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import {
  IntegrationUiCardSchema,
  type DeepSignalSignalKind,
  type IntegrationUiCard,
} from '@nessie/schemas'

/**
 * DeepSignal proactive-insight delivery shaping (deep-integration research §3).
 *
 * Instead of firehosing one channel message per `insight.surfaced` webhook, the
 * receiver folds insights into a single rolling "You have N new signals" digest
 * message per user, updated in place as more arrive within a window, and caps how
 * many *fresh* proactive digests it will start per user per rolling window. The
 * per-insight data (id, headline, kind) is retained on the message so nothing is
 * double-counted and the counts-by-kind summary stays accurate.
 *
 * The window/budget figures below are deliberate heuristics, NOT law: the
 * ambient-agent UX literature supports "batch / don't over-notify" qualitatively
 * but no specific cadence was substantiated, so each default is overridable via
 * env (read in the route and threaded through `SignalDigestOptions`).
 */

const HOUR_MS = 60 * 60 * 1000

/** Fold insights arriving within this window into one rolling digest message. */
export const DEFAULT_COALESCE_WINDOW_MS = HOUR_MS
/** Rolling window over which fresh proactive digests are budgeted. */
export const DEFAULT_BUDGET_WINDOW_MS = 24 * HOUR_MS
/** Max *new* proactive digest messages started per user per budget window. */
export const DEFAULT_BUDGET_MAX = 6

export const SIGNAL_DIGEST_KIND = 'signal_digest'
const DEEPSIGNAL_SLUG = 'deepsignal'
/** Where the digest card's primary action sends the user (the Signals inbox). */
const SIGNALS_INBOX_PATH = '/signals'

export type InsightSummary = {
  insightId: string
  headline: string
  kind: DeepSignalSignalKind | null
}

/** How a single insight was delivered into the user's channel. */
export type DigestDeliveryMode = 'posted' | 'coalesced' | 'suppressed' | 'duplicate'

export type SignalDigestOptions = {
  now?: Date
  coalesceWindowMs?: number
  budgetWindowMs?: number
  budgetMax?: number
}

export type DigestDelivery = {
  messageId: string
  mode: DigestDeliveryMode
}

type DigestRow = {
  id: string
  createdAt: Date
  metadata: Prisma.JsonValue
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Read the retained per-insight list off a digest message's metadata. */
const readInsights = (metadata: Prisma.JsonValue): InsightSummary[] => {
  const meta = isRecord(metadata) ? metadata : {}
  const external = isRecord(meta.external) ? meta.external : {}
  const raw = external.insights
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const insightId = entry.insightId
    const headline = entry.headline
    if (typeof insightId !== 'string' || typeof headline !== 'string') return []
    const kind = entry.kind
    const parsedKind =
      kind === 'opportunity' || kind === 'risk' || kind === 'signal' ? kind : null
    return [{ insightId, headline, kind: parsedKind }]
  })
}

type KindCounts = { opportunity: number; risk: number; signal: number; other: number }

const countByKind = (insights: InsightSummary[]): KindCounts => {
  const counts: KindCounts = { opportunity: 0, risk: 0, signal: 0, other: 0 }
  for (const insight of insights) {
    counts[insight.kind ?? 'other'] += 1
  }
  return counts
}

const buildDigestContent = (insights: InsightSummary[]): string => {
  const n = insights.length
  return `You have ${n} new signal${n === 1 ? '' : 's'} from DeepSignal`
}

/** Build the rolling digest card: counts by kind + a jump to the Signals inbox. */
const buildDigestCard = (insights: InsightSummary[]): IntegrationUiCard => {
  const counts = countByKind(insights)
  const fields = [
    counts.opportunity > 0 ? { label: 'Opportunities', value: String(counts.opportunity) } : null,
    counts.risk > 0 ? { label: 'Risks', value: String(counts.risk) } : null,
    counts.signal + counts.other > 0
      ? { label: 'Signals', value: String(counts.signal + counts.other) }
      : null,
  ].filter((field): field is { label: string; value: string } => field !== null)
  const latest = insights[insights.length - 1]
  const candidate = {
    kind: 'integration' as const,
    productSlug: DEEPSIGNAL_SLUG,
    title: buildDigestContent(insights),
    status: 'completed' as const,
    ...(latest ? { summary: `Latest: ${latest.headline}` } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    actions: [{ label: 'View signals', href: SIGNALS_INBOX_PATH, variant: 'primary' as const }],
  }
  return IntegrationUiCardSchema.parse(candidate)
}

const buildMetadata = (insights: InsightSummary[]): Prisma.InputJsonValue =>
  ({
    uiCards: [buildDigestCard(insights)],
    external: { product: DEEPSIGNAL_SLUG, kind: SIGNAL_DIGEST_KIND, insights },
  }) as Prisma.InputJsonValue

const loadRecentDigests = async (
  prisma: PrismaClient,
  threadId: string,
  since: Date,
): Promise<DigestRow[]> =>
  prisma.message.findMany({
    where: {
      threadId,
      createdAt: { gte: since },
      metadata: { path: ['external', 'kind'], equals: SIGNAL_DIGEST_KIND },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, metadata: true },
  })

/**
 * Deliver one insight into the user's rolling digest for a thread, coalescing +
 * budgeting per the options. Returns the message it touched and how, or `null`
 * when the insight can neither start a digest (over budget, none to fold into)
 * nor be recorded — the inbox still shows it via DeepSignal, source of truth.
 */
export const deliverInsightToDigest = async (
  prisma: PrismaClient,
  input: { threadId: string; agentId: string | null; insight: InsightSummary },
  options: SignalDigestOptions = {},
): Promise<DigestDelivery | null> => {
  const now = options.now ?? new Date()
  const coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS
  const budgetWindowMs = options.budgetWindowMs ?? DEFAULT_BUDGET_WINDOW_MS
  const budgetMax = options.budgetMax ?? DEFAULT_BUDGET_MAX
  const { threadId, agentId, insight } = input

  const recent = await loadRecentDigests(prisma, threadId, new Date(now.getTime() - budgetWindowMs))

  // Idempotency: an insight already folded into any recent digest is a no-op.
  for (const row of recent) {
    if (readInsights(row.metadata).some((entry) => entry.insightId === insight.insightId)) {
      return { messageId: row.id, mode: 'duplicate' }
    }
  }

  const newest = recent[0]
  const withinCoalesce =
    newest !== undefined && now.getTime() - newest.createdAt.getTime() < coalesceWindowMs

  const foldInto = async (row: DigestRow, mode: DigestDeliveryMode): Promise<DigestDelivery> => {
    const insights = [...readInsights(row.metadata), insight]
    await prisma.message.update({
      where: { id: row.id },
      data: { content: buildDigestContent(insights), metadata: buildMetadata(insights), editedAt: now },
    })
    return { messageId: row.id, mode }
  }

  // Within the coalesce window: fold into the current rolling digest, silently.
  if (withinCoalesce && newest) return foldInto(newest, 'coalesced')

  // A fresh window would start a new proactive interruption — budget it. Over
  // budget: still record the insight by folding into the latest digest (no new
  // message, no realtime ping); the interruption is suppressed.
  if (recent.length >= budgetMax) {
    return newest ? foldInto(newest, 'suppressed') : null
  }

  const insights = [insight]
  const message = await prisma.message.create({
    data: {
      agentId,
      threadId,
      role: 'assistant',
      content: buildDigestContent(insights),
      metadata: buildMetadata(insights),
    },
    select: { id: true },
  })
  return { messageId: message.id, mode: 'posted' }
}
