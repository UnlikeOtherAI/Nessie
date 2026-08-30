import { Prisma, type PrismaClient } from '@prisma/client'
import { ensureDefaultThread } from '@nessie/workspace-admin'
import type { PgRealtimeTransport } from '@nessie/runtime'
import { parseChannelId } from '@nessie/schemas'

type CallEvent = {
  channelId: string
  id: string
  meetingUri: string | null
  revision: number
  status: 'ended' | 'missed'
}

const lockCall = async (tx: Prisma.TransactionClient, callId: string): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM calls WHERE id = ${callId}::uuid FOR UPDATE`)
}

const publishCallUpdate = async (realtimeTransport: PgRealtimeTransport, call: CallEvent): Promise<void> => {
  await realtimeTransport.publishWs([{ kind: 'channel', channelId: parseChannelId(call.channelId) }], {
    event: 'call.updated',
    data: {
      callId: call.id,
      channelId: call.channelId,
      meetingUri: call.meetingUri,
      revision: call.revision,
      status: call.status,
    },
  })
}

/**
 * The delayed queue consumer. The row lock and all state predicates are
 * deliberate: a timeout that loses to Accept must do nothing, never overwrite
 * that invite with missed, and never post a false missed-call message.
 */
export const handleCallRingTimeout = async (
  prisma: PrismaClient,
  realtimeTransport: PgRealtimeTransport,
  callId: string,
): Promise<boolean> => {
  const missed = await prisma.$transaction(async (tx) => {
    await lockCall(tx, callId)
    const call = await tx.call.findUnique({
      where: { id: callId },
      select: {
        channelId: true,
        id: true,
        invites: { where: { state: 'accepted' }, select: { id: true } },
        meetingUri: true,
        startedBy: { select: { displayName: true } },
        status: true,
      },
    })
    if (!call || call.status !== 'ringing' || call.invites.length > 0) return null

    const transitioned = await tx.call.updateMany({
      where: { id: callId, status: 'ringing' },
      data: { endedAt: new Date(), revision: { increment: 1 }, status: 'missed' },
    })
    if (transitioned.count !== 1) return null
    await tx.callInvite.updateMany({
      where: { callId, state: 'ringing' },
      data: { respondedAt: new Date(), state: 'missed' },
    })

    const threadId = await ensureDefaultThread(tx as unknown as PrismaClient, call.channelId)
    await tx.message.create({
      data: {
        content: `Missed call from ${call.startedBy.displayName}`,
        metadata: { kind: 'call_missed' } as Prisma.InputJsonValue,
        role: 'assistant',
        threadId,
      },
    })
    const updated = await tx.call.findUniqueOrThrow({
      where: { id: callId },
      select: { channelId: true, id: true, meetingUri: true, revision: true, status: true },
    })
    return { ...updated, status: 'missed' as const }
  })
  if (!missed) return false
  await publishCallUpdate(realtimeTransport, missed)
  return true
}

export const sweepExpiredActiveCalls = async (
  prisma: PrismaClient,
  realtimeTransport: PgRealtimeTransport,
  before: Date,
): Promise<number> => {
  const candidates = await prisma.call.findMany({
    where: { startedAt: { lt: before }, status: 'active' },
    select: { id: true },
  })
  let count = 0
  for (const candidate of candidates) {
    const ended = await prisma.$transaction(async (tx) => {
      await lockCall(tx, candidate.id)
      const updated = await tx.call.updateMany({
        where: { id: candidate.id, startedAt: { lt: before }, status: 'active' },
        data: { endedAt: new Date(), revision: { increment: 1 }, status: 'ended' },
      })
      if (updated.count !== 1) return null
      return tx.call.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { channelId: true, id: true, meetingUri: true, revision: true, status: true },
      })
    })
    if (!ended) continue
    await publishCallUpdate(realtimeTransport, { ...ended, status: 'ended' })
    count += 1
  }
  return count
}
