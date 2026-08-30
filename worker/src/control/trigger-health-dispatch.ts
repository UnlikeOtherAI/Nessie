import type { PrismaClient } from '@prisma/client'
import type { TriggerHealthAlertJobPayload } from '@nessie/schemas'
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
 * Worker consumer for the `trigger.health-alert` topic: a scheduled trigger has
 * become non-runnable, and somebody has to be told.
 *
 * This is the fix for the failure mode that motivated the whole change — a
 * schedule that stopped firing and told nobody for 19 days, discoverable only by
 * opening the Triggers page and reading a delivery row. Unattended run failures
 * deliberately post nothing to chat (a 15-minute sweep that cannot reach its
 * provider would otherwise write the same apology four times an hour), so the
 * signal has to be an alert rather than a message: durable in the bell, pushed
 * once, and never repeated while the trigger sits in the same broken state.
 */

export type TriggerHealthDispatchPrisma = PushDeliveryPrisma &
  Pick<PrismaClient, 'agentTrigger' | 'organizationMember' | 'user' | 'userAlert'>

export type TriggerHealthDispatchDeps = {
  prisma: TriggerHealthDispatchPrisma
  authSecret: string
  webPush?: WebPushCredentials
  senders?: PushSenders
  now?: () => Date
  retryDelayMs?: (completedAttempt: number) => number
}

type TriggerContext = {
  name: string
  organizationId: string
  ownerUserId: string | null
}

/**
 * The trigger, its organisation, and the person who created it.
 *
 * Ownership comes from the server-owned `config.launchOrigin.userId` — the same
 * immutable tuple the fire path replays — not from whoever last edited the row.
 */
const loadTriggerContext = async (
  prisma: TriggerHealthDispatchPrisma,
  triggerId: string,
): Promise<TriggerContext | null> => {
  const trigger = await prisma.agentTrigger.findUnique({
    where: { id: triggerId },
    select: {
      agent: { select: { organizationId: true } },
      config: true,
      name: true,
      targetChannel: { select: { organizationId: true } },
      workflowInstallation: { select: { organizationId: true } },
    },
  })
  if (!trigger) return null

  const organizationId =
    trigger.agent?.organizationId
    ?? trigger.targetChannel?.organizationId
    ?? trigger.workflowInstallation?.organizationId
  if (!organizationId) return null

  const config = trigger.config
  const launchOrigin =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>)['launchOrigin']
      : null
  const ownerUserId =
    launchOrigin && typeof launchOrigin === 'object' && !Array.isArray(launchOrigin)
      ? (launchOrigin as Record<string, unknown>)['userId']
      : null

  return {
    name: trigger.name ?? 'Scheduled task',
    organizationId,
    ownerUserId: typeof ownerUserId === 'string' ? ownerUserId : null,
  }
}

/**
 * Who is told.
 *
 * The creator first: unlike a budget, this is their own automation and — for
 * `needs_reauthorization` — they are the person whose identity can repair it.
 * Organisation owners are included because they administer triggers and are the
 * fallback when the creator has left; a creator who is no longer an active
 * member is dropped rather than notified about work they can no longer reach.
 */
const resolveRecipientUserIds = async (
  prisma: TriggerHealthDispatchPrisma,
  context: TriggerContext,
): Promise<string[]> => {
  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId: context.organizationId,
      deactivatedAt: null,
      OR: [
        { role: 'owner' },
        ...(context.ownerUserId ? [{ userId: context.ownerUserId }] : []),
      ],
    },
    select: { userId: true },
  })
  return [...new Set(members.map((member) => member.userId))]
}

const buildAlertPayload = (
  payload: TriggerHealthAlertJobPayload,
  context: TriggerContext,
): PushPayload => ({
  title:
    payload.status === 'needs_reauthorization'
      ? `${context.name} needs reauthorizing`
      : `${context.name} stopped running`,
  // Deliberately generic: the specific cause lives on the trigger row behind
  // the deep link, so a lock-screen notification never carries a raw error.
  body:
    payload.status === 'needs_reauthorization'
      ? 'It can no longer prove the identity it was created with, so it has stopped.'
      : 'It cannot run and has stopped. Open it to see what needs fixing.',
  data: {
    kind: 'trigger_health',
    reason: payload.reason,
    triggerId: payload.triggerId,
    url: '/triggers',
  },
  collapseId: `trigger-health:${payload.triggerId}`,
})

export const handleTriggerHealthAlert = async (
  deps: TriggerHealthDispatchDeps,
  payload: TriggerHealthAlertJobPayload,
): Promise<PushDispatchSummary> => {
  const summary: PushDispatchSummary = { sent: 0, failed: 0, pruned: 0 }
  const context = await loadTriggerContext(deps.prisma, payload.triggerId)
  if (!context) {
    return summary
  }

  const recipientIds = await resolveRecipientUserIds(deps.prisma, context)
  if (recipientIds.length === 0) {
    return summary
  }

  // The durable half, written first and independently of push. A push can be
  // missed, silenced, or never registered; the bell is what guarantees the
  // failure is visible at all. `event_key` carries the health revision and
  // `user_alerts` is unique on (user_id, event_key), so a redelivered job or a
  // repeat failure in the same state cannot produce a second row.
  const eventKey = `trigger-health:${payload.triggerId}:${payload.healthRevision}`
  await deps.prisma.userAlert.createMany({
    data: recipientIds.map((userId) => ({
      eventKey,
      kind: 'trigger_health' as const,
      organizationId: context.organizationId,
      triggerId: payload.triggerId,
      userId,
    })),
    skipDuplicates: true,
  })

  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !deps.webPush) {
    return summary
  }

  const users = await deps.prisma.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true, preferences: true },
  })
  const now = deps.now?.() ?? new Date()
  const pushableIds = users
    .filter((user) => !shouldSuppressPushForPreferences(user.preferences, now, 'budgetAlerts'))
    .map((user) => user.id)
  if (pushableIds.length === 0) {
    return summary
  }

  const delivered = await deliverToRecipients({
    prisma: deps.prisma,
    apnsCreds,
    fcmCreds,
    ...(deps.webPush ? { webPush: deps.webPush } : {}),
    ...(deps.senders ? { senders: deps.senders } : {}),
    retryDelayMs: deps.retryDelayMs ?? defaultPushRetryDelayMs,
    payload: buildAlertPayload(payload, context),
    recipientIds: pushableIds,
    organizationId: context.organizationId,
    deepLinkUrl: '/triggers',
    messageId: null,
    surface: { kind: 'triggers' },
    now: deps.now ?? (() => new Date()),
  })
  summary.sent += delivered.sent
  summary.failed += delivered.failed
  summary.pruned += delivered.pruned

  console.log('[trigger-health-alert] done', {
    reason: payload.reason,
    recipients: pushableIds.length,
    status: payload.status,
    triggerId: payload.triggerId,
  })

  return summary
}
