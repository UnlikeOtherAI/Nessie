import type { PrismaClient } from '@prisma/client'
import type { BudgetAlertDispatchJobPayload } from '@nessie/schemas'
import type { PushPayload, WebPushCredentials } from '@nessie/push'
import { shouldSuppressPushForPreferences } from './push-preferences.js'
import { defaultPushRetryDelayMs } from './push-retry.js'
import {
  deliverToRecipients,
  loadPushCredentials,
  type PushDeliveryPrisma,
  type PushDispatchSummary,
  type PushSenders,
} from './push-delivery-core.js'

/**
 * Worker consumer for the `budget.alert-dispatch` queue topic. A scope Budget
 * has crossed its warn threshold ('threshold') or first blocked a run
 * ('blocked') this period; the once-per-period dedupe was already claimed by the
 * `budget_alerts` marker before enqueue. This resolves the people who should
 * know — the organisation owners who can inspect and change operational
 * budgets — writes each of them a durable `budget_alert` bell row, then filters
 * them by their push preferences and delivers through the shared
 * {@link deliverToRecipients} core, deep-linking to `/admin/usage`.
 *
 * The bell row comes first and does not depend on a device: an owner with no
 * registered phone or browser used to never hear of a budget at all. A push
 * preference silences the push, never the row — the rule mentions follow.
 *
 * This carries ONLY Nessie-local operational budget telemetry; it never touches
 * UOA customer credits/statements, which live on a separate surface.
 */

/** Minimal Prisma surface this handler touches — keeps tests light. */
export type BudgetAlertDispatchPrisma = PushDeliveryPrisma &
  Pick<PrismaClient, 'budgetAlert' | 'organizationMember' | 'user' | 'userAlert'>

export type BudgetAlertDispatchDeps = {
  prisma: BudgetAlertDispatchPrisma
  /** Independently rotated key ring for stored APNs/FCM credentials. */
  encryptionKeyRing: import('@nessie/runtime').EncryptionKeyRingInput
  /** VAPID credentials for browser Web Push (when configured). */
  webPush?: WebPushCredentials
  /** Push senders, injected so tests can stub them (default: real network). */
  senders?: PushSenders
  /** Clock injection keeps preference filtering deterministic in tests. */
  now?: () => Date
  /** Retry backoff injection; tests pass zero to stay fast. */
  retryDelayMs?: (completedAttempt: number) => number
}

/**
 * Budget management and the operational-usage page are owner-only. Keep the
 * recipient set to the people who can act on the alert instead of taking a
 * project or team manager to a page they cannot read. Deactivated members are
 * excluded.
 */
const resolveRecipientUserIds = async (
  prisma: BudgetAlertDispatchPrisma,
  payload: BudgetAlertDispatchJobPayload,
): Promise<string[]> => {
  const orgMembers = await prisma.organizationMember.findMany({
    where: {
      organizationId: payload.organizationId,
      deactivatedAt: null,
      role: 'owner',
    },
    select: { userId: true },
  })
  return orgMembers.map((member) => member.userId)
}

const buildBudgetAlertPayload = (payload: BudgetAlertDispatchJobPayload): PushPayload => {
  const title =
    payload.kind === 'blocked'
      ? `Budget reached — ${payload.scopeLabel} runs blocked`
      : `Budget alert — ${payload.scopeLabel}${
          payload.percentUsed === null ? '' : ` at ${payload.percentUsed}%`
        }`
  return {
    title,
    body: payload.reason,
    data: {
      kind: payload.kind,
      scopeType: payload.scopeType,
      scopeId: payload.scopeId,
      url: '/admin/usage',
    },
    collapseId: `budget:${payload.scopeType}:${payload.scopeId}:${payload.kind}`,
  }
}

/**
 * One bell row per owner, pointing at the marker the enqueue claimed. The event
 * key mirrors the enqueue's idempotency key, so a redelivered job writes
 * nothing twice (`user_alerts (user_id, event_key)` is unique) while next
 * period's alert for the same budget is a new row. A job enqueued by a replica
 * of the previous build carries no `periodStart`, so it cannot name its marker
 * and rings the push alone, as every budget alert did before.
 */
const writeBudgetAlertRows = async (
  prisma: BudgetAlertDispatchPrisma,
  payload: BudgetAlertDispatchJobPayload,
  recipientIds: readonly string[],
): Promise<number> => {
  if (!payload.periodStart || recipientIds.length === 0) return 0
  const marker = await prisma.budgetAlert.findUnique({
    where: {
      scopeType_scopeId_periodStart_kind: {
        kind: payload.kind,
        periodStart: new Date(payload.periodStart),
        scopeId: payload.scopeId,
        scopeType: payload.scopeType,
      },
    },
    select: { id: true, organizationId: true },
  })
  if (!marker || marker.organizationId !== payload.organizationId) return 0
  const eventKey = `budget-alert:${payload.scopeType}:${payload.scopeId}:${payload.periodStart}:${payload.kind}`
  const written = await prisma.userAlert.createMany({
    data: recipientIds.map((userId) => ({
      budgetAlertId: marker.id,
      eventKey,
      kind: 'budget_alert' as const,
      organizationId: payload.organizationId,
      userId,
    })),
    skipDuplicates: true,
  })
  return written.count
}

export const handleBudgetAlertDispatch = async (
  deps: BudgetAlertDispatchDeps,
  payload: BudgetAlertDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const retryDelayMs = deps.retryDelayMs ?? defaultPushRetryDelayMs
  const webPushEnabled = Boolean(deps.webPush)

  const candidateIds = await resolveRecipientUserIds(deps.prisma, payload)
  if (candidateIds.length === 0) {
    return summary
  }
  await writeBudgetAlertRows(deps.prisma, payload, candidateIds)

  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !webPushEnabled) {
    return summary
  }

  const users = await deps.prisma.user.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, preferences: true },
  })
  const now = deps.now?.() ?? new Date()
  const recipientIds = users
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'budgetAlerts'))
    .map((user) => user.id)
  if (recipientIds.length === 0) {
    return summary
  }

  const delivered = await deliverToRecipients({
    prisma: deps.prisma,
    apnsCreds,
    fcmCreds,
    ...(deps.webPush ? { webPush: deps.webPush } : {}),
    ...(deps.senders ? { senders: deps.senders } : {}),
    retryDelayMs,
    payload: buildBudgetAlertPayload(payload),
    recipientIds,
    organizationId: payload.organizationId,
    deepLinkUrl: '/admin/usage',
    messageId: null,
    // Mirrors the enqueue key (`budget-alert:<scope>:<periodStart>:<kind>`), so
    // a redelivered job rings nothing twice while the next period's alert for
    // the same scope is a different notification and still rings. A job from a
    // pre-deploy instance carries no `periodStart` and falls back to the coarse
    // period label, which no job enqueued after the deploy can collide with.
    notificationKey: [
      'push:budget',
      payload.scopeType,
      payload.scopeId,
      payload.kind,
      payload.periodStart ?? `period:${payload.period}`,
    ].join(':'),
    surface: { kind: 'ops_usage' },
    now: deps.now ?? (() => new Date()),
  })
  summary.sent += delivered.sent
  summary.failed += delivered.failed
  summary.pruned += delivered.pruned

  console.log('[budget-alert-dispatch] done', {
    organizationId: payload.organizationId,
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    kind: payload.kind,
    recipients: recipientIds.length,
    sent: summary.sent,
    failed: summary.failed,
    pruned: summary.pruned,
  })

  return summary
}
