import type { FastifyInstance } from 'fastify'
import { SetChannelMuteRequestSchema } from '@nessie/schemas'

import {
  AddChannelMemberBodySchema,
  ChannelRecordSchema,
  CreateChannelBodySchema,
  StartChannelConversationBodySchema,
  UpdateChannelBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  addMemberToChannel,
  removeMemberFromChannel,
} from '../services/channel-members.js'
import {
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
import { resolveSystemAgentConversation } from '../services/system-agent-conversations.js'
import { registerGlobalAgentRoutes } from './global-agents.js'
import { registerPersonalAssistantRoutes } from './personal-assistant.js'
import type { RouteDeps } from './types.js'

export const registerChannelRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    requireUserActor,
    getChannelIfMember,
  } = deps

  registerPersonalAssistantRoutes(app, deps)
  registerGlobalAgentRoutes(app, deps)

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
        ...(body.scope === 'standalone'
          ? { scope: 'standalone' as const }
          : {
              teamId:
                body.teamId
                ?? actorContext.tenant.teamId
                ?? actorContext.actionContext.teamId
                ?? '00000000-0000-4000-8000-000000000003',
            }),
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
    let channel
    try {
      channel = await setChannelArchived(prisma, {
        archived: false,
        channelId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })
    } catch (error) {
      // An archived channel does not hold its name, so somebody may have taken
      // it while this one was away. Say which name, not "internal error".
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

    if (channel.systemChannelType) {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'System-managed conversations cannot be modified',
      )
      return reply
    }

    // A DM is a fixed pair. Adding a third participant would either mutate a
    // private two-person history into something its participants never agreed
    // to, or silently fork it into a different channel; both are surprises. Use
    // a channel instead.
    if (channel.type === 'dm') {
      sendApiError(
        reply,
        403,
        'CHANNEL_DM_MEMBERS_FIXED',
        'Direct messages are between two participants. Create a channel to include more people.',
      )
      return reply
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
    if (channel.systemChannelType) {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'System-managed conversations cannot be modified',
      )
      return reply
    }
    // Symmetrical to the add path: removing either half of a pair would leave a
    // conversation with one participant and no way back.
    if (channel.type === 'dm') {
      sendApiError(
        reply,
        403,
        'CHANNEL_DM_MEMBERS_FIXED',
        'Direct messages are between two participants and cannot be changed.',
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
    const teamId =
      actorContext.tenant.teamId
      ?? actorContext.actionContext.teamId
      ?? '00000000-0000-4000-8000-000000000003'

    // Addressing a DM-homed system agent — the Personal Assistant, a global
    // agent such as the Agent Designer — opens this person's own home DM with
    // it rather than binding it into a new conversation, which the binding
    // chokepoint refuses by design. Member-level for that reason: it is not
    // placement, it is the conversation they already have.
    const outcome = agentIds.length > 0 && actorContext.actor.actorType === 'user'
      ? await resolveSystemAgentConversation(prisma, {
        agentIds,
        organizationId: actorContext.tenant.organizationId,
        teamId,
        userId: actorContext.actor.actorId,
        userIds,
      })
      : ({ kind: 'none' } as const)
    if (outcome.kind === 'exclusive') {
      sendApiError(
        reply,
        400,
        'SYSTEM_AGENT_CONVERSATION_EXCLUSIVE',
        `${outcome.agentName} works with you one to one, so it cannot join a `
        + 'conversation with other people or agents. Message it on its own, or '
        + 'leave it out of this one.',
      )
      return reply
    }
    if (outcome.kind === 'channel') {
      return reply
        .code(201)
        .send(createApiResponse(ChannelRecordSchema.parse(outcome.channel)))
    }

    if (agentIds.length > 0 && !requireOwner(actorContext, reply)) {
      return reply
    }

    const channel = await findOrCreatePrivateConversationChannel(prisma, {
      agentIds,
      currentUserId: actorContext.actor.actorId,
      organizationId: actorContext.tenant.organizationId,
      teamId,
      userIds,
    })

    if (!channel) {
      sendApiError(reply, 403, 'INVALID_CONVERSATION_RECIPIENTS', 'One or more recipients are not available')
      return reply
    }

    return reply.code(201).send(createApiResponse(ChannelRecordSchema.parse(channel)))
  })
}
