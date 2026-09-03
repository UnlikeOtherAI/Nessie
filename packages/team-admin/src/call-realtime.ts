import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseUserId,
} from '@nessie/schemas'

type CallRealtimePrisma = Pick<PrismaClient, 'call'>
type CallRealtimeTransport = Pick<import('@nessie/runtime').PgRealtimeTransport, 'publishWs'>

const callRealtimeSelect = {
  channel: { select: { id: true, label: true, organizationId: true } },
  id: true,
  invites: { select: { state: true, userId: true } },
  meetingUri: true,
  revision: true,
  ringExpiresAt: true,
  startedBy: { select: { avatarUrl: true, displayName: true, id: true } },
  status: true,
} as const

type CallRealtimeRecord = Prisma.CallGetPayload<{ select: typeof callRealtimeSelect }>

const loadCall = async (
  prisma: CallRealtimePrisma,
  callId: string,
): Promise<CallRealtimeRecord | null> => prisma.call.findUnique({
  where: { id: callId },
  select: callRealtimeSelect,
}) as Promise<CallRealtimeRecord | null>

const publishChannelUpdate = async (
  transport: CallRealtimeTransport,
  call: CallRealtimeRecord,
): Promise<void> => {
  await transport.publishWs([{ kind: 'channel', channelId: parseChannelId(call.channel.id) }], {
    event: 'call.updated',
    data: {
      callId: call.id,
      channelId: call.channel.id,
      meetingUri: call.meetingUri,
      revision: call.revision,
      status: call.status as 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'cancelled',
    },
  })
}

const userScope = (call: CallRealtimeRecord, userId: string) => [{
  kind: 'user' as const,
  organizationId: parseOrganizationId(call.channel.organizationId),
  userId: parseUserId(userId),
}]

/**
 * Starts with exactly one channel publication for the banner, then one
 * separate user-scoped incoming publication per invitee. Scopes must never be
 * combined: replay persists only the first scope and the hub prioritises user
 * delivery over a sibling channel scope.
 */
export const publishCallStartedRealtime = async (
  prisma: CallRealtimePrisma,
  transport: CallRealtimeTransport,
  callId: string,
): Promise<void> => {
  const call = await loadCall(prisma, callId)
  if (!call) return
  await publishChannelUpdate(transport, call)
  if (!call.meetingUri || !call.ringExpiresAt) return

  for (const invite of call.invites) {
    if (invite.state !== 'ringing') continue
    await transport.publishWs(userScope(call, invite.userId), {
      event: 'call.incoming',
      data: {
        callId: call.id,
        channelId: parseChannelId(call.channel.id),
        channelName: call.channel.label,
        caller: {
          id: parseUserId(call.startedBy.id),
          displayName: call.startedBy.displayName,
          avatarUrl: call.startedBy.avatarUrl ?? null,
        },
        meetingUri: call.meetingUri,
        expiresAt: call.ringExpiresAt.toISOString(),
        revision: call.revision,
      },
    })
  }
}

/** Publish a banner update plus recipient-private invite state changes. */
export const publishCallTransitionRealtime = async (
  prisma: CallRealtimePrisma,
  transport: CallRealtimeTransport,
  input: { callId: string; inviteeUserIds?: string[] },
): Promise<void> => {
  const call = await loadCall(prisma, input.callId)
  if (!call) return
  await publishChannelUpdate(transport, call)
  const invited = new Set(input.inviteeUserIds ?? [])
  for (const invite of call.invites) {
    if (!invited.has(invite.userId)) continue
    for (const userId of new Set([invite.userId, call.startedBy.id])) {
      await transport.publishWs(userScope(call, userId), {
        event: 'call.invite.updated',
        data: {
          callId: call.id,
          userId: parseUserId(invite.userId),
          state: invite.state as 'ringing' | 'accepted' | 'declined' | 'missed' | 'cancelled',
          revision: call.revision,
        },
      })
    }
  }
}
