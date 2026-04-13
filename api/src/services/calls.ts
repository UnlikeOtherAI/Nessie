import type { Prisma, PrismaClient } from '@prisma/client'
import { parseChannelId, parseUserId } from '@nessie/schemas'
import type { CallRecord } from '../contracts.js'

type DbClient = PrismaClient | Prisma.TransactionClient

const callWithParticipantsInclude = {
  participants: {
    include: {
      user: {
        select: {
          displayName: true,
          id: true,
        },
      },
    },
    orderBy: { joinedAt: 'asc' },
  },
} satisfies Prisma.CallInclude

type CallWithParticipants = Prisma.CallGetPayload<{
  include: typeof callWithParticipantsInclude
}>

export const mapCallRecord = (call: CallWithParticipants): CallRecord => ({
  id: call.id,
  channelId: parseChannelId(call.channelId),
  roomId: call.roomId,
  status: call.status === 'ended' ? 'ended' : 'active',
  startedById: parseUserId(call.startedById),
  startedAt: call.startedAt.toISOString(),
  endedAt: call.endedAt?.toISOString() ?? null,
  participants: call.participants.map((participant) => ({
    userId: parseUserId(participant.userId),
    displayName: participant.user.displayName,
    joinedAt: participant.joinedAt.toISOString(),
    leftAt: participant.leftAt?.toISOString() ?? null,
  })),
})

const getCallOrThrow = async (
  prisma: DbClient,
  callId: string,
): Promise<CallWithParticipants> => {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: callWithParticipantsInclude,
  })

  if (!call) {
    throw new Error('CALL_NOT_FOUND')
  }

  return call
}

export const createCall = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<CallRecord> => {
  const roomId = `nessie-${channelId.slice(0, 8)}-${Date.now().toString(16)}`

  const call = await prisma.$transaction(async (tx) => {
    const existing = await tx.call.findFirst({
      where: { channelId, status: 'active' },
      select: { id: true },
    })

    if (existing) {
      throw new Error('ACTIVE_CALL_EXISTS')
    }

    await tx.call.create({
      data: {
        channelId,
        roomId,
        startedById: userId,
        participants: {
          create: {
            userId,
          },
        },
      },
    })

    return tx.call.findFirstOrThrow({
      where: { roomId },
      include: callWithParticipantsInclude,
    })
  })

  return mapCallRecord(call)
}

export const joinCall = async (
  prisma: PrismaClient,
  callId: string,
  userId: string,
): Promise<CallRecord> => {
  const call = await prisma.$transaction(async (tx) => {
    const existing = await tx.call.findUnique({
      where: { id: callId },
      select: { status: true },
    })

    if (!existing) {
      throw new Error('CALL_NOT_FOUND')
    }

    if (existing.status !== 'active') {
      throw new Error('CALL_NOT_ACTIVE')
    }

    await tx.callParticipant.upsert({
      where: { callId_userId: { callId, userId } },
      create: {
        callId,
        userId,
      },
      update: {
        joinedAt: new Date(),
        leftAt: null,
      },
    })

    return getCallOrThrow(tx, callId)
  })

  return mapCallRecord(call)
}

export const leaveCall = async (
  prisma: PrismaClient,
  callId: string,
  userId: string,
): Promise<CallRecord> => {
  const call = await prisma.$transaction(async (tx) => {
    const existing = await tx.call.findUnique({
      where: { id: callId },
      select: { status: true },
    })

    if (!existing) {
      throw new Error('CALL_NOT_FOUND')
    }

    await tx.callParticipant.updateMany({
      where: {
        callId,
        userId,
        leftAt: null,
      },
      data: {
        leftAt: new Date(),
      },
    })

    const activeParticipantCount = await tx.callParticipant.count({
      where: {
        callId,
        leftAt: null,
      },
    })

    if (existing.status === 'active' && activeParticipantCount === 0) {
      await tx.call.update({
        where: { id: callId },
        data: {
          status: 'ended',
          endedAt: new Date(),
        },
      })
    }

    return getCallOrThrow(tx, callId)
  })

  return mapCallRecord(call)
}

export const endCall = async (
  prisma: PrismaClient,
  callId: string,
): Promise<CallRecord> => {
  const call = await prisma.$transaction(async (tx) => {
    const existing = await tx.call.findUnique({
      where: { id: callId },
      select: { id: true, status: true },
    })

    if (!existing) {
      throw new Error('CALL_NOT_FOUND')
    }

    const endedAt = new Date()

    await tx.callParticipant.updateMany({
      where: {
        callId,
        leftAt: null,
      },
      data: {
        leftAt: endedAt,
      },
    })

    await tx.call.update({
      where: { id: callId },
      data: {
        status: 'ended',
        endedAt,
      },
    })

    return getCallOrThrow(tx, callId)
  })

  return mapCallRecord(call)
}

export const getActiveCallForChannel = async (
  prisma: PrismaClient,
  channelId: string,
): Promise<CallRecord | null> => {
  const call = await prisma.call.findFirst({
    where: {
      channelId,
      status: 'active',
    },
    include: callWithParticipantsInclude,
    orderBy: { startedAt: 'desc' },
  })

  return call ? mapCallRecord(call) : null
}
