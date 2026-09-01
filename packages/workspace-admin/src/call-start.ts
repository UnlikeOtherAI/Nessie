import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'

import {
  createCallLinkForTeamUser,
  type CreateCallLinkDependencies,
  type CallLinkProvider,
} from './call-links.js'
import { enqueueCallRingDispatch } from './call-push-jobs.js'

const DEFAULT_RING_TIMEOUT_MS = 45_000

export class CallStartError extends Error {
  constructor(readonly code: 'ACTIVE_CALL_EXISTS' | 'CALL_REQUIRES_PARTICIPANTS' | 'CHANNEL_NOT_FOUND' | 'CHANNEL_SYSTEM_MANAGED') {
    super(code)
    this.name = 'CallStartError'
  }
}

const ringTimeoutMs = (env: Record<string, string | undefined>): number => {
  const configured = Number(env['NESSIE_CALL_RING_TIMEOUT_MS'])
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RING_TIMEOUT_MS
}

export type StartCallForUserInput = {
  actingUserId: string
  channelId: string
  createdViaAgentId?: string
  expectedOrganizationId?: string
  provider?: CallLinkProvider
}

export type StartCallForUserDependencies = {
  callLink?: CreateCallLinkDependencies
  env?: Record<string, string | undefined>
  now?: () => Date
}

/**
 * Creates a channel call under the target channel's organisation. A session
 * caller supplies its expected organisation; worker tools deliberately leave
 * it unset because they resolve the target channel's own organisation.
 */
export const startCallForUser = async (
  prisma: PrismaClient,
  input: StartCallForUserInput,
  dependencies: StartCallForUserDependencies = {},
) => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { id: true, organizationId: true, systemChannelType: true, teamId: true },
  })
  if (!channel || (input.expectedOrganizationId && channel.organizationId !== input.expectedOrganizationId)) {
    throw new CallStartError('CHANNEL_NOT_FOUND')
  }

  const actorMembership = await prisma.organizationMember.findFirst({
    where: {
      organizationId: channel.organizationId,
      userId: input.actingUserId,
      deactivatedAt: null,
    },
    select: { id: true },
  })
  if (!actorMembership) throw new CallStartError('CHANNEL_NOT_FOUND')
  const channelMembership = await prisma.channelMember.findFirst({
    where: { channelId: channel.id, userId: input.actingUserId },
    select: { id: true },
  })
  if (!channelMembership) throw new CallStartError('CHANNEL_NOT_FOUND')
  if (channel.systemChannelType === 'personal_assistant') {
    throw new CallStartError('CHANNEL_SYSTEM_MANAGED')
  }

  const humanMembers = await prisma.channelMember.findMany({
    where: {
      channelId: channel.id,
      user: {
        organizationMembers: {
          some: { organizationId: channel.organizationId, deactivatedAt: null },
        },
      },
    },
    select: { userId: true },
  })
  if (humanMembers.length < 2) throw new CallStartError('CALL_REQUIRES_PARTICIPANTS')

  const link = await createCallLinkForTeamUser(
    prisma,
    { provider: input.provider, teamId: channel.teamId, userId: input.actingUserId },
    dependencies.callLink,
  )
  const now = dependencies.now?.() ?? new Date()
  const timeoutMs = ringTimeoutMs(dependencies.env ?? process.env)
  const ringExpiresAt = new Date(now.getTime() + timeoutMs)

  try {
    return await prisma.$transaction(async (tx) => {
      // Re-read against the target tenant inside the write transaction. A user
      // removed while the provider link was minted must not create a call.
      const liveActor = await tx.organizationMember.findFirst({
        where: {
          organizationId: channel.organizationId,
          userId: input.actingUserId,
          deactivatedAt: null,
        },
        select: { id: true },
      })
      if (!liveActor) throw new CallStartError('CHANNEL_NOT_FOUND')
      const liveChannelMembership = await tx.channelMember.findFirst({
        where: { channelId: channel.id, userId: input.actingUserId },
        select: { id: true },
      })
      if (!liveChannelMembership) throw new CallStartError('CHANNEL_NOT_FOUND')

      const liveMembers = await tx.channelMember.findMany({
        where: {
          channelId: channel.id,
          user: {
            organizationMembers: {
              some: { organizationId: channel.organizationId, deactivatedAt: null },
            },
          },
        },
        select: { userId: true },
      })
      if (liveMembers.length < 2) throw new CallStartError('CALL_REQUIRES_PARTICIPANTS')

      const call = await tx.call.create({
        data: {
          channelId: channel.id,
          provider: link.provider,
          meetingUri: link.meetingUri,
          status: 'ringing',
          startedById: input.actingUserId,
          ...(input.createdViaAgentId ? { createdViaAgentId: input.createdViaAgentId } : {}),
          startedAt: now,
          ringExpiresAt,
          revision: 0,
          invites: {
            create: liveMembers
              .filter((member) => member.userId !== input.actingUserId)
              .map((member) => ({ userId: member.userId, state: 'ringing' })),
          },
        },
        include: {
          channel: { select: { label: true } },
          startedBy: { select: { displayName: true } },
          invites: { include: { user: { select: { displayName: true, id: true } } } },
          participants: { include: { user: { select: { displayName: true, id: true } } } },
        },
      })

      await enqueueQueueJob(tx, {
        delayMs: timeoutMs,
        idempotencyKey: `call:ring-timeout:${call.id}`,
        payload: { callId: call.id },
        topic: 'call.ring-timeout',
      })
      for (const invite of call.invites) {
        await enqueueCallRingDispatch(tx, { callId: call.id, userId: invite.userId })
      }
      return call
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new CallStartError('ACTIVE_CALL_EXISTS')
    }
    throw error
  }
}
