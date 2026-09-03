import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  CallLinkError,
  CallLinkProviderSchema,
  publishCallStartedRealtime,
  publishCallTransitionRealtime,
  startCallForUser,
  CallStartError,
  verifyCallActionToken,
} from '@nessie/team-admin'
import { z } from 'zod'
import { CallRecordSchema, EmptyBodySchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  acceptCallInvite,
  CallStateError,
  cancelCall,
  declineCallInvite,
  endCall,
  getCallInOrganization,
  getLiveCallForChannel,
  mapCallRecord,
  respondToCallInviteAction,
} from '../services/calls.js'
import { sendCallLinkError } from './call-link-error.js'
import type { RouteDeps } from './types.js'

const StartCallBodySchema = z.object({ provider: CallLinkProviderSchema.optional() }).strict()
const RespondToCallBodySchema = z.object({ token: z.string().min(1).max(2048) }).strict()

const sendStateError = (reply: FastifyReply, error: CallStateError): void => {
  const details: Record<CallStateError['code'], [number, string, string]> = {
    CALL_NOT_ACTIVE: [409, 'CALL_NOT_ACTIVE', 'Call is no longer active'],
    CALL_NOT_FOUND: [404, 'CALL_NOT_FOUND', 'Call not found'],
    CALL_NOT_INVITEE: [403, 'CALL_NOT_INVITEE', 'You are not invited to this call'],
    CALL_NO_LONGER_RINGING: [409, 'CALL_NO_LONGER_RINGING', 'Call is no longer ringing'],
    CALL_NOT_STARTED_BY_ACTOR: [403, 'CALL_NOT_STARTED_BY_ACTOR', 'Only the caller can cancel this call'],
  }
  const [status, code, message] = details[error.code]
  sendApiError(reply, status, code, message)
}

export const registerCallRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { authSecret, prisma, realtimeHub, requireActorContext, getChannelIfMember, getVisibleChannel } = deps

  const publishStarted = async (callId: string): Promise<void> => {
    try {
      await publishCallStartedRealtime(prisma, realtimeHub, callId)
    } catch (error) {
      app.log.error({ callId, err: error }, '[calls] failed to publish call start')
    }
  }
  const publishTransition = async (callId: string, inviteeUserIds?: string[]): Promise<void> => {
    try {
      await publishCallTransitionRealtime(prisma, realtimeHub, {
        callId,
        ...(inviteeUserIds ? { inviteeUserIds } : {}),
      })
    } catch (error) {
      app.log.error({ callId, err: error }, '[calls] failed to publish call transition')
    }
  }

  const requireMemberCall = async (userId: string, organizationId: string, callId: string) => {
    const call = await getCallInOrganization(prisma, callId, organizationId)
    if (!call) return null
    const channel = await getChannelIfMember(userId, organizationId, call.channelId)
    return channel ? call : null
  }

  app.post('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    const body = parseInput(StartCallBodySchema, request.body ?? {}, reply)
    if (!actorContext || !body) return reply
    const { channelId } = request.params as { channelId: string }
    try {
      const created = await startCallForUser(
        prisma,
        {
          channelId,
          actingUserId: actorContext.actor.actorId,
          expectedOrganizationId: actorContext.tenant.organizationId,
          ...(body.provider ? { provider: body.provider } : {}),
        },
        { callLink: { encryptionSecret: authSecret } },
      )
      const call = CallRecordSchema.parse(mapCallRecord(created))
      await publishStarted(call.id)
      return reply.code(201).send(createApiResponse(call))
    } catch (error) {
      if (error instanceof CallStartError) {
        if (error.code === 'CHANNEL_NOT_FOUND') sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
        else if (error.code === 'CHANNEL_SYSTEM_MANAGED') sendApiError(reply, 403, 'CHANNEL_SYSTEM_MANAGED', 'Calls are not available in the Personal Assistant DM')
        else if (error.code === 'CALL_REQUIRES_PARTICIPANTS') sendApiError(reply, 400, 'CALL_REQUIRES_PARTICIPANTS', 'Calls require at least two channel members')
        else sendApiError(reply, 409, 'ACTIVE_CALL_EXISTS', 'An active call already exists for this channel')
        return reply
      }
      if (error instanceof CallLinkError) {
        sendCallLinkError(reply, error)
        return reply
      }
      throw error
    }
  })

  const registerInviteTransition = (
    path: '/api/calls/:callId/accept' | '/api/calls/:callId/decline',
    transition: typeof acceptCallInvite | typeof declineCallInvite,
  ): void => {
    app.post(path, async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext || !parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
      const { callId } = request.params as { callId: string }
      if (!(await requireMemberCall(actorContext.actor.actorId, actorContext.tenant.organizationId, callId))) {
        sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
        return reply
      }
      try {
        const result = await transition(prisma, callId, actorContext.actor.actorId)
        const call = CallRecordSchema.parse(result.call)
        if (result.changed) {
          await publishTransition(call.id, [actorContext.actor.actorId])
        }
        if (!result.changed) return reply.code(200).send(createApiResponse({ ...call, code: 'CALL_ALREADY_ACCEPTED' }))
        return createApiResponse(call)
      } catch (error) {
        if (error instanceof CallStateError) {
          sendStateError(reply, error)
          return reply
        }
        throw error
      }
    })
  }
  registerInviteTransition('/api/calls/:callId/accept', acceptCallInvite)
  registerInviteTransition('/api/calls/:callId/decline', declineCallInvite)

  // This is intentionally the only unauthenticated call route. The encrypted
  // Web Push payload carries its signed, expiring, single-use action token;
  // service workers cannot send the SPA's bearer token or refresh cookie.
  app.post('/api/calls/:callId/respond', async (request, reply) => {
    const body = parseInput(RespondToCallBodySchema, request.body ?? {}, reply)
    if (!body) return reply
    const { callId } = request.params as { callId: string }
    const claims = verifyCallActionToken(body.token, authSecret)
    if (!claims || claims.callId !== callId) {
      sendApiError(reply, 401, 'CALL_RESPONSE_TOKEN_INVALID', 'Invalid call response token')
      return reply
    }
    try {
      const result = await respondToCallInviteAction(prisma, {
        action: claims.action,
        callId,
        userId: claims.userId,
      })
      await publishTransition(result.call.id, [claims.userId])
      return reply.code(204).send()
    } catch (error) {
      if (error instanceof CallStateError) {
        // Never disclose a call or invite through the unauthenticated path.
        sendApiError(reply, 401, 'CALL_RESPONSE_TOKEN_INVALID', 'Invalid call response token')
        return reply
      }
      throw error
    }
  })

  app.post('/api/calls/:callId/cancel', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !parseInput(EmptyBodySchema, request.body ?? {}, reply)) return reply
    const { callId } = request.params as { callId: string }
    if (!(await requireMemberCall(actorContext.actor.actorId, actorContext.tenant.organizationId, callId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    try {
      const result = await cancelCall(prisma, callId, actorContext.actor.actorId)
      const call = CallRecordSchema.parse(result.call)
      await publishTransition(call.id, call.invites.filter((invite) => invite.state === 'cancelled').map((invite) => invite.userId))
      return createApiResponse(call)
    } catch (error) {
      if (error instanceof CallStateError) {
        sendStateError(reply, error)
        return reply
      }
      throw error
    }
  })

  app.delete('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { channelId } = request.params as { channelId: string }
    if (!(await getChannelIfMember(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    const liveCall = await getLiveCallForChannel(prisma, channelId)
    if (!liveCall) {
      sendApiError(reply, 404, 'CALL_NOT_FOUND', 'Call not found')
      return reply
    }
    try {
      const result = await endCall(prisma, liveCall.id, actorContext.actor.actorId)
      const call = CallRecordSchema.parse(result.call)
      const ringingInviteeIds = call.invites.filter((invite) => invite.state === 'ringing').map((invite) => invite.userId)
      await publishTransition(call.id, ringingInviteeIds)
      return createApiResponse(call)
    } catch (error) {
      if (error instanceof CallStateError) {
        sendStateError(reply, error)
        return reply
      }
      throw error
    }
  })

  app.get('/api/channels/:channelId/call', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { channelId } = request.params as { channelId: string }
    if (!(await getVisibleChannel(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId))) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    const result = await getLiveCallForChannel(prisma, channelId)
    return createApiResponse(result ? CallRecordSchema.parse(result) : null)
  })
}
