import type { FastifyInstance } from 'fastify'
import { SetChannelMuteRequestSchema } from '@nessie/schemas'

import {
  AddChannelMemberBodySchema,
  ChannelRecordSchema,
  CreateChannelBodySchema,
  PersonalAssistantBootstrapResponseSchema,
  StartChannelConversationBodySchema,
  UpdateChannelBodySchema,
} from '../contracts.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from '../db/bootstrap.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  addMemberToChannel,
  removeMemberFromChannel,
} from '../services/channel-members.js'
import {
  createGroupFromDm,
  findOrCreatePrivateConversationChannel,
  findOrCreateDmChannel,
} from '../services/channel-dms.js'
import {
  ChannelSlugConflictError,
  ChannelValidationError,
  createChannelForUser,
  joinPublicChannel,
  listChannelsForUser,
  setChannelArchived,
  updateChannel,
} from '../services/channels.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import type { RouteDeps } from './types.js'

export const registerChannelRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    requireUserActor,
    loadPersonalAssistantState,
    getChannelIfMember,
  } = deps

  app.get('/api/channels', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const query = request.query as { teamId?: string; includeArchived?: string }
    const channels = await listChannelsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      query.teamId,
      // sp-channels: archived channels are excluded unless explicitly requested
      query.includeArchived === 'true',
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

    let channel
    try {
      channel = await createChannelForUser(prisma, {
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
    } catch (error) {
      // sp-channels: surface invalid channel names as a 400 instead of a 500
      if (error instanceof ChannelValidationError) {
        sendApiError(reply, 400, 'INVALID_CHANNEL_NAME', error.message)
        return reply
      }
      if (error instanceof ChannelSlugConflictError) {
        sendApiError(reply, 409, 'CHANNEL_SLUG_CONFLICT', error.message)
        return reply
      }
      throw error
    }

    if (!channel) {
      sendApiError(reply, 400, 'HIERARCHY_VIOLATION', 'Team does not belong to this organization')
      return reply
    }

    return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(channel)))
  })

  // ─── sp-channels: channel lifecycle ───────────────────────────────────────

  app.patch('/api/channels/:channelId/notifications', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const body = parseInput(SetChannelMuteRequestSchema, request.body, reply)
    if (!body) {
      return reply
    }

    const membership = await prisma.channelMember.findFirst({
      where: {
        channelId,
        userId: actorContext.actor.actorId,
        channel: { is: { organizationId: actorContext.tenant.organizationId } },
      },
      select: { id: true },
    })
    if (!membership) {
      sendApiError(reply, 404, 'CHANNEL_MEMBER_NOT_FOUND', 'Channel membership not found')
      return reply
    }

    const updated = await prisma.channelMember.update({
      where: { id: membership.id },
      data: { muted: body.muted },
      select: { muted: true },
    })

    return createApiResponse({ muted: updated.muted })
  })

  app.patch('/api/channels/:channelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const body = parseInput(UpdateChannelBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let channel
    try {
      channel = await updateChannel(prisma, {
        channelId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      })
    } catch (error) {
      if (error instanceof ChannelValidationError) {
        sendApiError(reply, 400, 'INVALID_CHANNEL_NAME', error.message)
        return reply
      }
      if (error instanceof ChannelSlugConflictError) {
        sendApiError(reply, 409, 'CHANNEL_SLUG_CONFLICT', error.message)
        return reply
      }
      throw error
    }

    if (!channel) {
      sendApiError(reply, 403, 'CHANNEL_FORBIDDEN', 'Channel not found or insufficient permissions')
      return reply
    }

    return createApiResponse(ChannelRecordSchema.parse(channel))
  })

  app.post('/api/channels/:channelId/archive', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await setChannelArchived(prisma, {
      archived: true,
      channelId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!channel) {
      sendApiError(reply, 403, 'CHANNEL_FORBIDDEN', 'Channel not found or insufficient permissions')
      return reply
    }
    return createApiResponse(ChannelRecordSchema.parse(channel))
  })

  app.post('/api/channels/:channelId/unarchive', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await setChannelArchived(prisma, {
      archived: false,
      channelId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!channel) {
      sendApiError(reply, 403, 'CHANNEL_FORBIDDEN', 'Channel not found or insufficient permissions')
      return reply
    }
    return createApiResponse(ChannelRecordSchema.parse(channel))
  })

  // Soft delete: archive the channel rather than hard-deleting its history.
  app.delete('/api/channels/:channelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await setChannelArchived(prisma, {
      archived: true,
      channelId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!channel) {
      sendApiError(reply, 403, 'CHANNEL_FORBIDDEN', 'Channel not found or insufficient permissions')
      return reply
    }
    return reply.code(204).send()
  })

  app.post('/api/channels/:channelId/join', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const channel = await joinPublicChannel(prisma, {
      channelId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!channel) {
      sendApiError(reply, 403, 'CHANNEL_JOIN_FORBIDDEN', 'Channel is not a joinable public channel')
      return reply
    }
    return createApiResponse(ChannelRecordSchema.parse(channel))
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
      let group
      try {
        group = await createGroupFromDm(prisma, {
          dmChannelId: channelId,
          newUserId: body.userId,
          currentUserId: actorContext.actor.actorId,
        })
      } catch (error) {
        if (error instanceof ChannelSlugConflictError) {
          sendApiError(reply, 409, 'CHANNEL_SLUG_CONFLICT', error.message)
          return reply
        }
        throw error
      }
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

  app.post('/api/channels/conversations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(StartChannelConversationBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const agentIds = body.agentIds ?? []
    const userIds = body.userIds ?? []

    if (agentIds.length > 0 && !requireOwner(actorContext, reply)) {
      return reply
    }

    const channel = await findOrCreatePrivateConversationChannel(prisma, {
      agentIds,
      currentUserId: actorContext.actor.actorId,
      organizationId: actorContext.tenant.organizationId,
      teamId:
        actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? '00000000-0000-4000-8000-000000000003',
      userIds,
    })

    if (!channel) {
      sendApiError(reply, 403, 'INVALID_CONVERSATION_RECIPIENTS', 'One or more recipients are not available')
      return reply
    }

    return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(channel)))
  })
}
