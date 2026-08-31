import type { FastifyInstance } from 'fastify'

import {
  DeletePersonalAssistantPresenceBodySchema,
  PersonalAssistantBootstrapResponseSchema,
} from '../contracts.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from '../db/bootstrap.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { ensurePersonalAssistantAvatar } from '../services/personal-assistant-avatar.js'
import { ensurePersonalAssistantBootstrap } from '../services/personal-assistant.js'
import {
  addPersonalAssistantPresence,
  removePersonalAssistantPresence,
} from '../services/personal-assistant-presence.js'
import { sendAgentAvatarGenerationError } from './agent-route-errors.js'
import type { RouteDeps } from './types.js'

/**
 * The organization-singleton PA has one route home. Keeping its DM bootstrap
 * and shared-channel-presence routes together makes the exception explicit and
 * prevents a second binding writer from being added to generic channel routes.
 */
export const registerPersonalAssistantRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { getChannelIfMember, loadPersonalAssistantState, prisma, requireActorContext, requireUserActor } = deps

  app.get('/api/personal-assistant', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply
    return createApiResponse(await loadPersonalAssistantState(actorContext))
  })

  app.post('/api/personal-assistant/bootstrap', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply

    let bootstrap: Awaited<ReturnType<typeof ensurePersonalAssistantBootstrap>>
    try {
      bootstrap = await ensurePersonalAssistantBootstrap(prisma, {
        organizationId: actorContext.tenant.organizationId,
        teamId:
          actorContext.tenant.teamId
          ?? actorContext.actionContext.teamId
          ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId,
        userId: actorContext.actor.actorId,
      })
      await ensurePersonalAssistantAvatar({
        actorContext,
        config: deps.config.model,
        fileService: deps.fileService,
        ledgerIdentity: deps.ledgerIdentity,
        modelClient: deps.sharedModelClient,
        organizationId: actorContext.tenant.organizationId,
        prisma,
      })
    } catch (error) {
      if (sendAgentAvatarGenerationError(reply, error)) return reply
      throw error
    }
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

  app.post('/api/channels/:channelId/personal-assistant', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply

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
    if (channel.systemChannelType !== null) {
      sendApiError(reply, 403, 'CHANNEL_SYSTEM_MANAGED', 'Personal Assistant presences require a shared channel')
      return reply
    }

    await ensurePersonalAssistantBootstrap(prisma, {
      organizationId: actorContext.tenant.organizationId,
      teamId:
        actorContext.tenant.teamId
        ?? actorContext.actionContext.teamId
        ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId,
      userId: actorContext.actor.actorId,
    })
    const result = await addPersonalAssistantPresence(prisma, {
      channelId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (result.kind !== 'created') {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    return reply.code(201).send(createApiResponse(result.presence))
  })

  app.delete('/api/channels/:channelId/personal-assistant', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext || !requireUserActor(actorContext, reply)) return reply

    const body = parseInput(
      DeletePersonalAssistantPresenceBodySchema,
      request.body ?? {},
      reply,
    )
    if (!body) return reply
    const { channelId } = request.params as { channelId: string }
    const result = await removePersonalAssistantPresence(prisma, {
      actorUserId: actorContext.actor.actorId,
      channelId,
      organizationId: actorContext.tenant.organizationId,
      principalUserId: body.principalUserId ?? actorContext.actor.actorId,
    })
    if (result.kind === 'forbidden') {
      sendApiError(reply, 403, 'PERSONAL_ASSISTANT_PRESENCE_FORBIDDEN', 'You cannot remove this Personal Assistant presence')
      return reply
    }
    if (result.kind === 'not_found') {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    return reply.code(204).send()
  })
}
