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
 * budgets — filters them by their push preferences, and delivers through the
 * shared {@link deliverToRecipients} core, deep-linking to `/ops/usage`.
 *
 * This carries ONLY Nessie-local operational budget telemetry; it never touches
 * UOA customer credits/statements, which live on a separate surface.
 */

/** Minimal Prisma surface this handler touches — keeps tests light. */
export type BudgetAlertDispatchPrisma = PushDeliveryPrisma &
  Pick<PrismaClient, 'organizationMember' | 'user'>

export type BudgetAlertDispatchDeps = {
  prisma: BudgetAlertDispatchPrisma
  /** Deployment auth secret — the key the secret store encrypted creds under. */
  authSecret: string
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
      url: '/ops/usage',
    },
    collapseId: `budget:${payload.scopeType}:${payload.scopeId}:${payload.kind}`,
  }
}

export const handleBudgetAlertDispatch = async (
  deps: BudgetAlertDispatchDeps,
  payload: BudgetAlertDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const retryDelayMs = deps.retryDelayMs ?? defaultPushRetryDelayMs
  const webPushEnabled = Boolean(deps.webPush)

  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !webPushEnabled) {
    return summary
  }

  const candidateIds = await resolveRecipientUserIds(deps.prisma, payload)
  if (candidateIds.length === 0) {
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
    deepLinkUrl: '/ops/usage',
    messageId: null,
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
