import type { FastifyInstance } from 'fastify'

import { parseChannelId } from '@nessie/schemas'
import { CallRecordSchema, EmptyBodySchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createCall,
  endCall,
  getActiveCallForChannel,
  joinCall,
  leaveCall,
} from '../services/calls.js'
import type { RouteDeps } from './types.js'

export const registerCallRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    getChannelIfMember,
    getVisibleChannel,
  } = deps

  app.post('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      channelId,
    )
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Calls are not available in the Personal Assistant DM',
      )
      return reply
    }

    const body = parseInput(EmptyBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const memberCount = await prisma.channelMember.count({
      where: { channelId },
    })
    if (memberCount < 2) {
      sendApiError(reply, 400, 'CALL_REQUIRES_PARTICIPANTS', 'Calls require at least two channel members')
      return reply
    }

    try {
      const result = await createCall(prisma, channelId, actorContext.actor.actorId)

      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            roomId: result.roomId,
            startedBy: result.startedById,
          },
          event: 'call.started',
        },
      )

      return reply.code(201).send(createApiResponse(CallRecordSchema.parse(result)))
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_CALL_EXISTS') {
        sendApiError(reply, 409, 'ACTIVE_CALL_EXISTS', 'An active call already exists for this channel')
        return reply
      }

      throw error
    }
  })

  app.post('/api/calls/:callId/join', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { callId } = request.params as { callId: string }
    const body = parseInput(EmptyBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        channelId: true,
        status: true,
      },
    })
    if (!call) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }

    if (
      !(await getChannelIfMember(
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
        call.channelId,
      ))
    ) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    try {
      const result = await joinCall(prisma, callId, actorContext.actor.actorId)

      const participant = result.participants.find((entry) => entry.userId === actorContext.actor.actorId)
      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            userId: actorContext.actor.actorId,
            displayName: participant?.displayName ?? actorContext.actor.actorId,
          },
          event: 'call.joined',
        },
      )

      return createApiResponse(CallRecordSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'CALL_NOT_FOUND') {
        sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
        return reply
      }

      if (error instanceof Error && error.message === 'CALL_NOT_ACTIVE') {
        sendApiError(reply, 409, 'CALL_NOT_ACTIVE', 'Call is no longer active')
        return reply
      }

      throw error
    }
  })

  app.post('/api/calls/:callId/leave', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { callId } = request.params as { callId: string }
    const body = parseInput(EmptyBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        channelId: true,
      },
    })
    if (!call) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }

    if (
      !(await getChannelIfMember(
        actorContext.actor.actorId,
        actorContext.tenant.organizationId,
        call.channelId,
      ))
    ) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    try {
      const result = await leaveCall(prisma, callId, actorContext.actor.actorId)

      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            userId: actorContext.actor.actorId,
          },
          event: 'call.left',
        },
      )

      if (result.status === 'ended') {
        await realtimeHub.publishWs(
          [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
          {
            data: {
              callId: result.id,
              channelId: result.channelId,
              endedAt: result.endedAt,
            },
            event: 'call.ended',
          },
        )
      }

      return createApiResponse(CallRecordSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'CALL_NOT_FOUND') {
        sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
        return reply
      }

      throw error
    }
  })

  app.delete('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    if (!(await getChannelIfMember(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const activeCall = await prisma.call.findFirst({
      where: {
        channelId,
        status: 'active',
      },
      select: {
        id: true,
      },
      orderBy: { startedAt: 'desc' },
    })
    if (!activeCall) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }

    try {
      const result = await endCall(prisma, activeCall.id)

      await realtimeHub.publishWs(
        [{ kind: 'channel', channelId: parseChannelId(result.channelId) }],
        {
          data: {
            callId: result.id,
            channelId: result.channelId,
            endedAt: result.endedAt,
          },
          event: 'call.ended',
        },
      )

      return createApiResponse(CallRecordSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'CALL_NOT_FOUND') {
        sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
        return reply
      }

      throw error
    }
  })

  app.get('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    if (!(await getVisibleChannel(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const result = await getActiveCallForChannel(prisma, channelId)
    return createApiResponse(result ? CallRecordSchema.parse(result) : null)
  })
}
