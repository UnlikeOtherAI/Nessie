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
 * know — the org owners plus the budget scope's managers — filters them by their
 * push preferences, and delivers through the shared {@link deliverToRecipients}
 * core, deep-linking to `/ops/usage` (the owner-only local telemetry surface).
 *
 * This carries ONLY Nessie-local operational budget telemetry; it never touches
 * UOA customer credits/statements, which live on a separate surface.
 */

/** Minimal Prisma surface this handler touches — keeps tests light. */
export type BudgetAlertDispatchPrisma = PushDeliveryPrisma &
  Pick<PrismaClient, 'organizationMember' | 'projectMember' | 'teamMember' | 'user'>

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

const MANAGER_ROLES = ['owner', 'admin'] as const

/**
 * The people who should be told about a budget alert: the org owners always,
 * plus the budget scope's managers (team/project owners + admins, or org admins
 * for an org-scoped budget). Deactivated org members are excluded.
 */
const resolveRecipientUserIds = async (
  prisma: BudgetAlertDispatchPrisma,
  payload: BudgetAlertDispatchJobPayload,
): Promise<string[]> => {
  const ids = new Set<string>()

  const orgRoles = payload.scopeType === 'organization' ? [...MANAGER_ROLES] : ['owner']
  const orgMembers = await prisma.organizationMember.findMany({
    where: {
      organizationId: payload.organizationId,
      deactivatedAt: null,
      role: { in: orgRoles as ('owner' | 'admin')[] },
    },
    select: { userId: true },
  })
  for (const member of orgMembers) ids.add(member.userId)

  if (payload.scopeType === 'team') {
    const managers = await prisma.teamMember.findMany({
      where: { teamId: payload.scopeId, role: { in: [...MANAGER_ROLES] } },
      select: { userId: true },
    })
    for (const member of managers) ids.add(member.userId)
  } else if (payload.scopeType === 'project') {
    const managers = await prisma.projectMember.findMany({
      where: { projectId: payload.scopeId, role: { in: [...MANAGER_ROLES] } },
      select: { userId: true },
    })
    for (const member of managers) ids.add(member.userId)
  }

  return [...ids]
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
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now))
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
