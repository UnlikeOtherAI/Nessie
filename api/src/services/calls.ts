import { Prisma, type PrismaClient } from '@prisma/client'
import { parseChannelId, parseUserId } from '@nessie/schemas'
import type { CallRecord } from '../contracts.js'

type DbClient = PrismaClient | Prisma.TransactionClient

const callInclude = {
  invites: {
    include: { user: { select: { displayName: true, id: true } } },
    orderBy: { userId: 'asc' },
  },
  participants: {
    include: { user: { select: { displayName: true, id: true } } },
    orderBy: { joinedAt: 'asc' },
  },
} satisfies Prisma.CallInclude

type CallWithPeople = Prisma.CallGetPayload<{ include: typeof callInclude }>
type CallStatus = CallRecord['status']

export class CallStateError extends Error {
  constructor(readonly code: 'CALL_NOT_ACTIVE' | 'CALL_NOT_FOUND' | 'CALL_NOT_INVITEE' | 'CALL_NO_LONGER_RINGING' | 'CALL_NOT_STARTED_BY_ACTOR') {
    super(code)
    this.name = 'CallStateError'
  }
}

const terminalStatuses = new Set<CallStatus>(['cancelled', 'declined', 'ended', 'missed'])

export const mapCallRecord = (call: CallWithPeople): CallRecord => ({
  id: call.id,
  channelId: parseChannelId(call.channelId),
  roomId: call.roomId,
  provider: call.provider as CallRecord['provider'],
  meetingUri: call.meetingUri,
  status: call.status as CallStatus,
  startedById: parseUserId(call.startedById),
  startedAt: call.startedAt.toISOString(),
  ringExpiresAt: call.ringExpiresAt?.toISOString() ?? null,
  endedAt: call.endedAt?.toISOString() ?? null,
  revision: call.revision,
  participants: call.participants.map((participant) => ({
    userId: parseUserId(participant.userId),
    displayName: participant.user.displayName,
    joinedAt: participant.joinedAt.toISOString(),
    leftAt: participant.leftAt?.toISOString() ?? null,
  })),
  invites: call.invites.map((invite) => ({
    userId: parseUserId(invite.userId),
    displayName: invite.user.displayName,
    state: invite.state as CallRecord['invites'][number]['state'],
    respondedAt: invite.respondedAt?.toISOString() ?? null,
  })),
})

const loadCall = async (prisma: DbClient, callId: string): Promise<CallWithPeople> => {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: callInclude })
  if (!call) throw new CallStateError('CALL_NOT_FOUND')
  return call
}

const lockCall = async (tx: Prisma.TransactionClient, callId: string): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM calls WHERE id = ${callId}::uuid FOR UPDATE`)
}

export const getCallInOrganization = async (
  prisma: PrismaClient,
  callId: string,
  organizationId: string,
): Promise<CallRecord | null> => {
  const call = await prisma.call.findFirst({
    where: { id: callId, channel: { organizationId } },
    include: callInclude,
  })
  return call ? mapCallRecord(call) : null
}

export const getLiveCallForChannel = async (
  prisma: PrismaClient,
  channelId: string,
): Promise<CallRecord | null> => {
  const call = await prisma.call.findFirst({
    where: { channelId, status: { in: ['ringing', 'active'] } },
    include: callInclude,
    orderBy: { startedAt: 'desc' },
  })
  return call ? mapCallRecord(call) : null
}

export type CallTransition = { call: CallRecord; changed: boolean }

export const acceptCallInvite = async (
  prisma: PrismaClient,
  callId: string,
  userId: string,
): Promise<CallTransition> => prisma.$transaction(async (tx) => {
  await lockCall(tx, callId)
  const current = await loadCall(tx, callId)
  if (terminalStatuses.has(current.status as CallStatus)) throw new CallStateError('CALL_NO_LONGER_RINGING')
  const invite = current.invites.find((entry) => entry.userId === userId)
  if (!invite) throw new CallStateError('CALL_NOT_INVITEE')
  if (invite.state === 'accepted') return { call: mapCallRecord(current), changed: false }

  const accepted = await tx.callInvite.updateMany({
    where: { callId, userId, state: 'ringing' },
    data: { state: 'accepted', respondedAt: new Date() },
  })
  if (accepted.count !== 1) {
    const refreshed = await loadCall(tx, callId)
    if (refreshed.invites.some((entry) => entry.userId === userId && entry.state === 'accepted')) {
      return { call: mapCallRecord(refreshed), changed: false }
    }
    throw new CallStateError('CALL_NO_LONGER_RINGING')
  }
  const activated = await tx.call.updateMany({
    where: { id: callId, status: 'ringing' },
    data: { status: 'active', revision: { increment: 1 } },
  })
  if (current.status === 'ringing' && activated.count !== 1) {
    throw new CallStateError('CALL_NO_LONGER_RINGING')
  }
  return { call: mapCallRecord(await loadCall(tx, callId)), changed: true }
})

export const declineCallInvite = async (
  prisma: PrismaClient,
  callId: string,
  userId: string,
): Promise<CallTransition> => prisma.$transaction(async (tx) => {
  await lockCall(tx, callId)
  const current = await loadCall(tx, callId)
  if (terminalStatuses.has(current.status as CallStatus)) throw new CallStateError('CALL_NO_LONGER_RINGING')
  if (!current.invites.some((entry) => entry.userId === userId)) throw new CallStateError('CALL_NOT_INVITEE')
  const declined = await tx.callInvite.updateMany({
    where: { callId, userId, state: 'ringing' },
    data: { state: 'declined', respondedAt: new Date() },
  })
  if (declined.count !== 1) throw new CallStateError('CALL_NO_LONGER_RINGING')
  const ringingInvites = await tx.callInvite.count({ where: { callId, state: 'ringing' } })
  const acceptedInvites = await tx.callInvite.count({ where: { callId, state: 'accepted' } })
  const completed = await tx.call.updateMany({
    where: {
      id: callId,
      ...(acceptedInvites === 0 && ringingInvites === 0
        ? { status: 'ringing' }
        : { status: 'active' }),
    },
    data: {
      ...(acceptedInvites === 0 && ringingInvites === 0
        ? { endedAt: new Date(), status: 'declined' }
        : {}),
      revision: { increment: 1 },
    },
  })
  if (completed.count !== 1) throw new CallStateError('CALL_NO_LONGER_RINGING')
  return { call: mapCallRecord(await loadCall(tx, callId)), changed: true }
})

export const cancelCall = async (
  prisma: PrismaClient,
  callId: string,
  userId: string,
): Promise<CallTransition> => prisma.$transaction(async (tx) => {
  await lockCall(tx, callId)
  const current = await loadCall(tx, callId)
  if (current.startedById !== userId) throw new CallStateError('CALL_NOT_STARTED_BY_ACTOR')
  const cancelled = await tx.call.updateMany({
    where: { id: callId, status: 'ringing' },
    data: { status: 'cancelled', endedAt: new Date(), revision: { increment: 1 } },
  })
  if (cancelled.count !== 1) throw new CallStateError('CALL_NO_LONGER_RINGING')
  await tx.callInvite.updateMany({
    where: { callId, state: 'ringing' },
    data: { state: 'cancelled', respondedAt: new Date() },
  })
  return { call: mapCallRecord(await loadCall(tx, callId)), changed: true }
})

export const endCall = async (
  prisma: PrismaClient,
  callId: string,
  userId: string,
): Promise<CallTransition> => prisma.$transaction(async (tx) => {
  await lockCall(tx, callId)
  const current = await loadCall(tx, callId)
  const invitedAndAccepted = current.invites.some((entry) => entry.userId === userId && entry.state === 'accepted')
  if (current.startedById !== userId && !invitedAndAccepted) throw new CallStateError('CALL_NOT_INVITEE')
  const ended = await tx.call.updateMany({
    where: { id: callId, status: 'active' },
    data: { status: 'ended', endedAt: new Date(), revision: { increment: 1 } },
  })
  if (ended.count !== 1) throw new CallStateError('CALL_NOT_ACTIVE')
  return { call: mapCallRecord(await loadCall(tx, callId)), changed: true }
})
