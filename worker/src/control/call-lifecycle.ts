import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  enqueueCallRingCancellation,
  ensureDefaultThread,
  publishCallTransitionRealtime,
} from '@nessie/workspace-admin'
import type { PgRealtimeTransport } from '@nessie/runtime'

const lockCall = async (tx: Prisma.TransactionClient, callId: string): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM calls WHERE id = ${callId}::uuid FOR UPDATE`)
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
        invites: { select: { id: true, state: true, userId: true } },
        startedBy: { select: { displayName: true, id: true } },
        status: true,
      },
    })
    if (!call || call.status !== 'ringing' || call.invites.some((invite) => invite.state === 'accepted')) return null

    const transitioned = await tx.call.updateMany({
      where: { id: callId, status: 'ringing' },
      data: { endedAt: new Date(), revision: { increment: 1 }, status: 'missed' },
    })
    if (transitioned.count !== 1) return null
    const missedInviteeIds = call.invites
      .filter((invite) => invite.state === 'ringing')
      .map((invite) => invite.userId)
    await tx.callInvite.updateMany({
      where: { callId, state: 'ringing' },
      data: { respondedAt: new Date(), state: 'missed' },
    })

    const threadId = await ensureDefaultThread(tx as unknown as PrismaClient, call.channelId)
    const channel = await tx.channel.findUniqueOrThrow({
      where: { id: call.channelId },
      select: { organizationId: true },
    })
    await tx.message.create({
      data: {
        content: `Missed call from ${call.startedBy.displayName}`,
        metadata: { kind: 'call_missed' } as Prisma.InputJsonValue,
        role: 'assistant',
        threadId,
      },
    })
    await tx.userAlert.createMany({
      data: missedInviteeIds.map((userId) => ({
        actorUserId: call.startedBy.id,
        callId,
        channelId: call.channelId,
        eventKey: `call:${callId}:missed:${userId}`,
        kind: 'call_missed' as const,
        organizationId: channel.organizationId,
        threadId,
        userId,
      })),
      skipDuplicates: true,
    })
    const alerts = await tx.userAlert.findMany({
      where: { userId: { in: missedInviteeIds }, eventKey: { in: missedInviteeIds.map((userId) => `call:${callId}:missed:${userId}`) } },
      select: { id: true },
    })
    for (const alert of alerts) {
      await enqueueQueueJob(tx, {
        idempotencyKey: `attention:call-missed:${alert.id}`,
        payload: { alertId: alert.id },
        topic: 'attention.dispatch',
      })
    }
    await enqueueCallRingCancellation(tx, { callId, userIds: missedInviteeIds })
    return { callId, missedInviteeIds }
  })
  if (!missed) return false
  await publishCallTransitionRealtime(prisma, realtimeTransport, missed)
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
      const ringingInviteeIds = (await tx.call.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { invites: { where: { state: 'ringing' }, select: { userId: true } } },
      })).invites.map((invite) => invite.userId)
      await enqueueCallRingCancellation(tx, { callId: candidate.id, userIds: ringingInviteeIds })
      return { callId: candidate.id, ringingInviteeIds }
    })
    if (!ended) continue
    await publishCallTransitionRealtime(prisma, realtimeTransport, {
      callId: ended.callId,
      inviteeUserIds: ended.ringingInviteeIds,
    })
    count += 1
  }
  return count
}
