import type { FastifyInstance } from 'fastify'

import {
  AddChannelMemberBodySchema,
  ChannelRecordSchema,
  CreateChannelBodySchema,
  PersonalAssistantBootstrapResponseSchema,
} from '../contracts.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from '../db/bootstrap.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  addMemberToChannel,
  createChannelForUser,
  createGroupFromDm,
  findOrCreateDmChannel,
  listChannelsForUser,
  removeMemberFromChannel,
} from '../services/channels.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import type { RouteDeps } from './types.js'

export const registerChannelRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    loadPersonalAssistantState,
    getChannelIfMember,
  } = deps

  app.get('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = request.query as { teamId?: string }
    const channels = await listChannelsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      query.teamId,
    )

    return createApiResponse(ChannelRecordSchema.array().parse(channels))
  })

  app.get('/api/personal-assistant', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    return createApiResponse(await loadPersonalAssistantState(actorContext))
  })

  app.post('/api/personal-assistant/bootstrap', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const bootstrap = await ensurePersonalAssistantBootstrap(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId:
        actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId,
      userId: actorContext.actor.actorId,
    })
    const state = await loadPersonalAssistantState(actorContext)
    if (!state?.agent || !state.channel || !state.thread) {
      sendApiError(
        reply,
        500,
        'PERSONAL_ASSISTANT_BOOTSTRAP_FAILED',
        'Failed to load personal assistant state after bootstrap',
      )
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'personal_assistant.bootstrap' as Parameters<typeof emitAuditEvent>[1]['action'],
      outcome: 'success',
      resourceId: bootstrap.agentId,
      resourceType: 'agent',
    })

    return reply.code(200).send(
      createApiResponse(
        PersonalAssistantBootstrapResponseSchema.parse({
          agent: state.agent,
          channel: state.channel,
          configSummary: state.configSummary,
          instance: null,
          thread: state.thread,
        }),
      ),
    )
  })

  app.post('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateChannelBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const channel = await createChannelForUser(prisma, {
      label: body.label,
      visibility: body.visibility ?? 'public',
      organizationId: actorContext.tenant.organizationId,
      teamId:
        body.teamId
        ?? actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? '00000000-0000-4000-8000-000000000003',
      userId: actorContext.actor.actorId,
    })

    if (!channel) {
      sendApiError(reply, 400, 'HIERARCHY_VIOLATION', 'Team does not belong to this organization')
      return reply
    }

    return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(channel)))
  })

  app.post('/api/channels/:channelId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await getChannelIfMember(actorContext.actor.actorId, actorContext.tenant.organizationId, channelId)
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    const body = parseInput(AddChannelMemberBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    if (channel.systemChannelType === 'personal_assistant') {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Personal Assistant DMs cannot be modified',
      )
      return reply
    }

    // If the channel is a DM, create a new group channel instead of mutating the DM
    if (channel.type === 'dm') {
      const group = await createGroupFromDm(prisma, {
        dmChannelId: channelId,
        newUserId: body.userId,
        currentUserId: actorContext.actor.actorId,
      })
      if (!group) {
        sendApiError(reply, 403, 'USER_NOT_IN_ORGANIZATION', 'Target user is not a member of this organization')
        return reply
      }
      return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(group)))
    }

    const added = await addMemberToChannel(prisma, channelId, body.userId)
    if (!added) {
      sendApiError(reply, 403, 'USER_NOT_IN_ORGANIZATION', 'Target user is not a member of this organization')
      return reply
    }
    return reply.code(204).send()
  })

  app.delete('/api/channels/:channelId/members/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string }
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
        'Personal Assistant DMs cannot be modified',
      )
      return reply
    }

    await removeMemberFromChannel(prisma, channelId, userId)
    return reply.code(204).send()
  })

  app.post('/api/dm/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { userId } = request.params as { userId: string }

    const channel = await findOrCreateDmChannel(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId ?? '00000000-0000-4000-8000-000000000003',
      currentUserId: actorContext.actor.actorId,
      targetUserId: userId,
    })

    if (!channel) {
      sendApiError(reply, 403, 'USER_NOT_IN_ORGANIZATION', 'Target user is not a member of this organization')
      return reply
    }

    return createApiResponse(ChannelRecordSchema.parse(channel))
  })
}
