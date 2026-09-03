import type { PrismaClient } from '@prisma/client'
import {
  issueCallActionToken,
} from '@nessie/team-admin'
import type {
  CallRingCancelJobPayload,
  CallRingDispatchJobPayload,
} from '@nessie/schemas'
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

const CALL_PUSH_PROTOCOL_VERSION = '1'
const CALL_PUSH_CATEGORY = 'incoming-calls'

export type CallRingDispatchPrisma = PushDeliveryPrisma & Pick<
  PrismaClient,
  'call' | 'channelMember' | 'organizationMember' | 'user'
>

export type CallRingDispatchDeps = {
  authSecret: string
  now?: () => Date
  prisma: CallRingDispatchPrisma
  retryDelayMs?: (completedAttempt: number) => number
  senders?: PushSenders
  webPush?: WebPushCredentials
}

type CallPushContext = {
  callId: string
  channelId: string
  channelLabel: string
  meetingUri: string | null
  organizationId: string
  revision: number
  ringExpiresAt: Date | null
  startedByDisplayName: string
  status: string
  inviteState: string
  userId: string
  userPreferences: unknown
}

const emptySummary = (): PushDispatchSummary => ({ failed: 0, pruned: 0, sent: 0 })

const loadCallPushContext = async (
  prisma: CallRingDispatchPrisma,
  input: { callId: string; userId: string },
): Promise<CallPushContext | null> => {
  const call = await prisma.call.findUnique({
    where: { id: input.callId },
    select: {
      channel: { select: { id: true, label: true, organizationId: true } },
      id: true,
      invites: { where: { userId: input.userId }, select: { state: true } },
      meetingUri: true,
      revision: true,
      ringExpiresAt: true,
      startedBy: { select: { displayName: true } },
      status: true,
    },
  })
  if (!call) return null
  const [invite] = call.invites
  if (!invite || call.invites.length !== 1) return null
  const [membership, channelMembership, user] = await Promise.all([
    prisma.organizationMember.findFirst({
      where: {
        deactivatedAt: null,
        organizationId: call.channel.organizationId,
        userId: input.userId,
      },
      select: { id: true },
    }),
    prisma.channelMember.findFirst({
      where: { channelId: call.channel.id, userId: input.userId },
      select: { id: true },
    }),
    prisma.user.findUnique({ where: { id: input.userId }, select: { preferences: true } }),
  ])
  if (!membership || !channelMembership || !user) return null

  return {
    callId: call.id,
    channelId: call.channel.id,
    channelLabel: call.channel.label,
    meetingUri: call.meetingUri,
    organizationId: call.channel.organizationId,
    revision: call.revision,
    ringExpiresAt: call.ringExpiresAt,
    startedByDisplayName: call.startedBy.displayName,
    status: call.status,
    inviteState: invite.state,
    userId: input.userId,
    userPreferences: user.preferences,
  }
}

const ringPath = (context: CallPushContext): string =>
  `/channels/${context.channelId}?incomingCall=${context.callId}`

const nativeRingPayload = (context: CallPushContext): PushPayload => ({
  body: `${context.startedByDisplayName} is calling in ${context.channelLabel}`,
  category: CALL_PUSH_CATEGORY,
  collapseId: context.callId,
  data: {
    callId: context.callId,
    kind: 'call.ring',
    path: ringPath(context),
    revision: String(context.revision),
    version: CALL_PUSH_PROTOCOL_VERSION,
  },
  priority: 'high',
  title: 'Incoming call',
})

const webRingPayload = (context: CallPushContext, authSecret: string): PushPayload => {
  if (!context.meetingUri || !context.ringExpiresAt) {
    throw new Error('A ringing call must have a meeting URI and expiry')
  }
  const expiresAt = Math.floor(context.ringExpiresAt.getTime() / 1000)
  return {
    ...nativeRingPayload(context),
    data: {
      ...nativeRingPayload(context).data,
      acceptToken: issueCallActionToken({
        action: 'accept', callId: context.callId, expiresAt, userId: context.userId,
      }, authSecret),
      declineToken: issueCallActionToken({
        action: 'decline', callId: context.callId, expiresAt, userId: context.userId,
      }, authSecret),
      meetingUri: context.meetingUri,
    },
  }
}

const cancelPayload = (context: CallPushContext): PushPayload => ({
  body: '',
  category: CALL_PUSH_CATEGORY,
  collapseId: context.callId,
  data: {
    callId: context.callId,
    kind: 'call.cancel',
    path: ringPath(context),
    revision: String(context.revision),
    version: CALL_PUSH_PROTOCOL_VERSION,
  },
  priority: 'high',
  title: '',
})

const deliver = async (
  deps: CallRingDispatchDeps,
  context: CallPushContext,
  payload: PushPayload,
  webPayload?: PushPayload,
): Promise<PushDispatchSummary> => {
  const { apnsCreds, fcmCreds } = await loadPushCredentials(deps)
  if (!apnsCreds && !fcmCreds && !deps.webPush) return emptySummary()
  return deliverToRecipients({
    apnsCreds,
    bypassSurfaceSuppression: true,
    deepLinkUrl: ringPath(context),
    fcmCreds,
    messageId: null,
    now: deps.now ?? (() => new Date()),
    organizationId: context.organizationId,
    payload,
    prisma: deps.prisma,
    recipientIds: [context.userId],
    retryDelayMs: deps.retryDelayMs ?? defaultPushRetryDelayMs,
    ...(deps.senders ? { senders: deps.senders } : {}),
    surface: { kind: 'ops_usage' },
    ...(deps.webPush ? { webPush: deps.webPush } : {}),
    ...(webPayload ? { webPayload } : {}),
  })
}

/** Deliver one invitee's call ring after rechecking membership and preferences. */
export const handleCallRingDispatch = async (
  deps: CallRingDispatchDeps,
  payload: CallRingDispatchJobPayload,
): Promise<PushDispatchSummary> => {
  const context = await loadCallPushContext(deps.prisma, payload)
  const now = deps.now?.() ?? new Date()
  if (
    !context
    || context.status !== 'ringing'
    || context.inviteState !== 'ringing'
    || !context.meetingUri
    || !context.ringExpiresAt
    || context.ringExpiresAt <= now
    || shouldSuppressPushForPreferences(context.userPreferences, now, 'incomingCalls')
  ) return emptySummary()

  return deliver(deps, context, nativeRingPayload(context), webRingPayload(context, deps.authSecret))
}

/** A cancellation is silent protocol cleanup, so it still reaches a device after a preference change. */
export const handleCallRingCancel = async (
  deps: CallRingDispatchDeps,
  payload: CallRingCancelJobPayload,
): Promise<PushDispatchSummary> => {
  const context = await loadCallPushContext(deps.prisma, payload)
  if (!context) return emptySummary()
  return deliver(deps, context, cancelPayload(context))
}
