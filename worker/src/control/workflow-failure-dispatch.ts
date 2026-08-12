import type { PrismaClient } from '@prisma/client'
import type { WorkflowRunFailureDispatchJobPayload } from '@nessie/schemas'
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
 * W23 — a failed workflow run reaches a human. Worker consumer for the
 * `workflow.run.failure-dispatch` topic: resolves the people who can act —
 * the installation's creator and the managers of the installation's channel —
 * by their **current** entitlement rows at delivery time (never a role label
 * captured at enqueue), filters by push preferences, and delivers through the
 * shared {@link deliverToRecipients} core, deep-linking the run.
 *
 * The push payload carries no raw error or input data: the deep link is the
 * diagnostic, and W0's redaction boundary stays the only read path.
 */

export type WorkflowFailureDispatchPrisma = PushDeliveryPrisma &
  Pick<PrismaClient, 'channelMember' | 'organizationMember' | 'user' | 'workflowInstallation' | 'workflowRun'>

export type WorkflowFailureDispatchDeps = {
  prisma: WorkflowFailureDispatchPrisma
  authSecret: string
  webPush?: WebPushCredentials
  senders?: PushSenders
  now?: () => Date
  retryDelayMs?: (completedAttempt: number) => number
}

/**
 * Recipients: the installation creator (when still an active org member) plus
 * current managers (channel owners) of the installation's channel. Both sets are resolved from
 * live membership rows, so a demoted manager or deactivated creator stops
 * receiving alerts immediately.
 */
export const resolveWorkflowFailureRecipientIds = async (
  prisma: WorkflowFailureDispatchPrisma,
  payload: WorkflowRunFailureDispatchJobPayload,
): Promise<string[]> => {
  const installation = await prisma.workflowInstallation.findFirst({
    where: { id: payload.workflowInstallationId, organizationId: payload.organizationId },
    select: { channelId: true, createdByActorId: true, createdByActorType: true },
  })
  if (!installation) {
    return []
  }

  const candidateIds = new Set<string>()

  if (installation.createdByActorType === 'user') {
    const creatorMembership = await prisma.organizationMember.findFirst({
      where: {
        organizationId: payload.organizationId,
        userId: installation.createdByActorId,
        deactivatedAt: null,
      },
      select: { userId: true },
    })
    if (creatorMembership) {
      candidateIds.add(creatorMembership.userId)
    }
  }

  if (installation.channelId) {
    const managers = await prisma.channelMember.findMany({
      where: { channelId: installation.channelId, role: 'owner' },
      select: { userId: true },
    })
    for (const manager of managers) {
      candidateIds.add(manager.userId)
    }
  }

  return [...candidateIds]
}

const buildWorkflowFailurePayload = (
  payload: WorkflowRunFailureDispatchJobPayload,
  templateName: string | null,
): PushPayload => ({
  title: `Workflow run failed${templateName ? ` — ${templateName}` : ''}`,
  body: 'A workflow run failed. Open the run to inspect what happened.',
  data: {
    kind: 'workflow_run_failed',
    workflowInstallationId: payload.workflowInstallationId,
    workflowRunId: payload.workflowRunId,
    url: `/workflows?failedRun=${payload.workflowRunId}`,
  },
  collapseId: `workflow-run:${payload.workflowRunId}`,
})

export const handleWorkflowRunFailureDispatch = async (
  deps: WorkflowFailureDispatchDeps,
  payload: WorkflowRunFailureDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const retryDelayMs = deps.retryDelayMs ?? defaultPushRetryDelayMs
  const webPushEnabled = Boolean(deps.webPush)

  const run = await deps.prisma.workflowRun.findFirst({
    where: {
      id: payload.workflowRunId,
      installationId: payload.workflowInstallationId,
      organizationId: payload.organizationId,
      status: 'failed',
    },
    select: { id: true, installation: { select: { workflowTemplate: { select: { name: true } } } } },
  })
  // The run may have been cancelled/retried past this alert, or deleted; an
  // alert for a run that is no longer failed would be a lie.
  if (!run) {
    return summary
  }

  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !webPushEnabled) {
    return summary
  }

  const candidateIds = await resolveWorkflowFailureRecipientIds(deps.prisma, payload)
  if (candidateIds.length === 0) {
    return summary
  }

  const users = await deps.prisma.user.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, preferences: true },
  })
  const now = deps.now?.() ?? new Date()
  const recipientIds = users
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'assignedWork'))
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
    payload: buildWorkflowFailurePayload(payload, run.installation.workflowTemplate.name ?? null),
    recipientIds,
    organizationId: payload.organizationId,
    deepLinkUrl: `/workflows?failedRun=${payload.workflowRunId}`,
    messageId: null,
    // No workflows surface kind exists in PushSurfaceKind; channel presence is
    // the nearest honest "already looking at it" signal for a channel-bound
    // installation, and a missing channel suppresses nothing.
    surface: { kind: 'ops_usage' },
    now: deps.now ?? (() => new Date()),
  })
  summary.sent += delivered.sent
  summary.failed += delivered.failed
  summary.pruned += delivered.pruned

  console.log('[workflow-failure-dispatch] done', {
    organizationId: payload.organizationId,
    workflowRunId: payload.workflowRunId,
    recipients: recipientIds.length,
    sent: summary.sent,
    failed: summary.failed,
  })

  return summary
}
