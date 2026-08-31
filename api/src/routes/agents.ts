import type { FastifyInstance } from 'fastify'

import {
  AgentModelOptionSchema,
  AgentRecordSchema,
  CreateAgentBindingBodySchema,
  CreateAgentBodySchema,
  GenerateAgentAvatarBodySchema,
  GeneratedAgentAvatarSchema,
  UpdateAgentBodySchema,
  UpdateAgentAvatarBodySchema,
} from '../contracts.js'
import { parseAgentId } from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  AgentAvatarGenerationError,
  generateAgentAvatar,
} from '../services/agent-avatar-generation.js'
import { updateAgentAvatar } from '../services/agent-avatars.js'
import { canAccessAttachment } from '../services/attachments.js'
import {
  bindAgentToChannel,
  cloneAgentRecord,
  createAgentRecord,
  listAgentsForUser,
  loadAgentActivity,
  loadAgentChildren,
  loadAgentMessages,
  loadAgentStatus,
  loadRunToolCalls,
  unbindAgentFromChannel,
  updateAgentRecord,
  validateAgentCreateInput,
} from '../services/agents.js'
import { enqueueInvitedAgentMentionReplay } from '../services/agent-invite-reply.js'
import {
  assertLedgerAgentModelSelection,
  ledgerAgentModelCatalogRequestHeaders,
  listLedgerAgentModels,
  randomAgentAvatarBackgroundColor,
} from '@nessie/workspace-admin'
import { checkPolicy } from '../services/policy.js'
import {
  sendAgentManagementError,
  sendAgentAvatarGenerationError,
  sendAgentModelCatalogError,
  sendProtectedPolicyError,
} from './agent-route-errors.js'
import type { RouteDeps } from './types.js'

const validateAgentAvatarAttachment = async (input: {
  actorContext: NonNullable<ReturnType<RouteDeps['requireActorContext']>>
  attachmentId: string
  deps: Pick<RouteDeps, 'prisma'>
  reply: Parameters<typeof sendApiError>[0]
}): Promise<boolean> => {
  const attachment = await input.deps.prisma.attachment.findUnique({
    where: { id: input.attachmentId },
  })
  if (
    !attachment
    || !(await canAccessAttachment(input.deps.prisma, attachment, {
      organizationId: input.actorContext.tenant.organizationId,
      userId: input.actorContext.actor.actorId,
    }))
  ) {
    sendApiError(input.reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
    return false
  }
  if (attachment.kind !== 'image') {
    sendApiError(input.reply, 400, 'INVALID_AVATAR', 'Avatar must be an image')
    return false
  }
  return true
}

export const registerAgentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    requireOwner,
    getChannelIfMember,
    isAgentAccessibleToActor,
    createAgentVisibilityScope,
  } = deps

  app.get('/api/agents', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    // `?scope=all` opts the Agents page into the read-only system tier (the
    // Personal Assistant and other `systemManaged` agents) so it can group them
    // under its Personal / Global tabs. Every other caller omits it and gets the
    // unchanged non-system list.
    const includeSystemManaged =
      (request.query as { scope?: string }).scope === 'all'
    const agents = await listAgentsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      isOwner,
      includeSystemManaged,
    )
    return createApiResponse(AgentRecordSchema.array().parse(agents))
  })

  app.get('/api/agents/models', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    try {
      const models = await listLedgerAgentModels({
        config: deps.config.model,
        ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL,
        requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
          actorContext,
          ledgerIdentity: deps.ledgerIdentity,
        }),
      })
      return createApiResponse(AgentModelOptionSchema.array().parse(models))
    } catch (error) {
      if (sendAgentModelCatalogError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/agents', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateAgentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    // Creating an agent is member-level, but enabling its to-do capability is
    // agent configuration and therefore follows the owner-only update route.
    // Refuse the protected input instead of silently dropping it so callers
    // can distinguish an authorization failure from an ordinary disabled agent.
    if (body.todosEnabled === true && !actorContext.actor.roles?.includes('owner')) {
      sendApiError(
        reply,
        403,
        'AGENT_TODOS_OWNER_REQUIRED',
        'Only organization owners can enable to-dos for an agent.',
      )
      return reply
    }

    if (
      body.avatarAttachmentId
      && !(await validateAgentAvatarAttachment({
        actorContext,
        attachmentId: body.avatarAttachmentId,
        deps,
        reply,
      }))
    ) {
      return reply
    }

    let agent
    try {
      // Validate before a missing avatar triggers billed prompt/image calls.
      await validateAgentCreateInput(prisma, {
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
        parentAgentId: body.parentAgentId,
        toolPolicy: body.toolPolicy,
      })
      if (body.model !== undefined || body.provider !== undefined) {
        await assertLedgerAgentModelSelection({
          config: deps.config.model,
          ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL,
          model: body.model,
          provider: body.provider,
          requestHeaders: () => ledgerAgentModelCatalogRequestHeaders({
            actorContext,
            ledgerIdentity: deps.ledgerIdentity,
          }),
        })
      }
      let generatedAvatar
      if (!body.avatarAttachmentId) {
        if (!deps.sharedModelClient) {
          throw new AgentAvatarGenerationError('The model service is not configured.')
        }
        generatedAvatar = await generateAgentAvatar({
          actorContext,
          agent: {
            name: body.name,
            role: body.role ?? 'assistant',
            systemPrompt: body.systemPrompt,
          },
          config: deps.config.model,
          fileService: deps.fileService,
          ledgerIdentity: deps.ledgerIdentity,
          modelClient: deps.sharedModelClient,
        })
      }
      agent = await createAgentRecord(prisma, {
        avatarAttachmentId: body.avatarAttachmentId ?? generatedAvatar?.avatarAttachmentId,
        avatarBackgroundColor: generatedAvatar?.avatarBackgroundColor,
        effort: body.effort,
        model: body.model,
        name: body.name,
        organizationId: actorContext.tenant.organizationId,
        // The person clicking "create" is this agent's steward, so a member
        // keeps sight of it before it is bound to any channel.
        ownerUserId: actorContext.actor.actorId,
        parentAgentId: body.parentAgentId,
        projectId: actorContext.tenant.projectId,
        provider: body.provider,
        role: body.role ?? 'assistant',
        runLimits: body.runLimits,
        systemPrompt: body.systemPrompt,
        teamId: actorContext.tenant.teamId,
        todosEnabled: body.todosEnabled,
        toolPolicy: body.toolPolicy,
      })
    } catch (error) {
      if (sendProtectedPolicyError(reply, error)) return reply
      if (sendAgentManagementError(reply, error)) return reply
      if (sendAgentModelCatalogError(reply, error)) return reply
      if (sendAgentAvatarGenerationError(reply, error)) return reply
      throw error
    }

    // Provenance: a column transfer overwrites the current steward, so who
    // originally created an agent survives only in the tamper-evident chain.
    // Nothing emitted this before, which is exactly why no honest ownership
    // backfill was possible for existing rows.
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'agent.created',
      metadata: { ownerUserId: actorContext.actor.actorId },
      outcome: 'success',
      resourceId: agent.id,
      resourceType: 'agent',
    })

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(agent)))
  })

  app.put('/api/agents/:agentId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(UpdateAgentBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const existingAgent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: {
        model: true,
        ownerUserId: true,
        provider: true,
        systemManaged: true,
      },
    })
    if (
      !existingAgent
      || !(await isAgentAccessibleToActor(actorContext, agentId))
    ) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    // Seeing a shared agent is not permission to rewrite it. Visibility comes
    // from a channel binding, so any member of a public channel the agent is
    // bound to could otherwise change its systemPrompt, toolPolicy or model —
    // a same-tenant takeover of an agent other people rely on.
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    let agent
    try {
      if (body.model !== undefined || body.provider !== undefined) {
        await assertLedgerAgentModelSelection({
          config: deps.config.model,
          ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL,
          model: body.model ?? existingAgent.model ?? undefined,
          provider: body.provider ?? existingAgent.provider ?? undefined,
          requestHeaders: () => ledgerAgentModelCatalogRequestHeaders({
            actorContext,
            ledgerIdentity: deps.ledgerIdentity,
          }),
        })
      }
      agent = await updateAgentRecord(prisma, agentId, {
        ...body,
        organizationId: actorContext.tenant.organizationId,
      })
    } catch (error) {
      if (sendProtectedPolicyError(reply, error)) return reply
      if (sendAgentModelCatalogError(reply, error)) return reply
      throw error
    }
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    // A transfer changes who can see this agent at all, so it is recorded in
    // the tamper-evident chain (a column overwrite keeps no history of its own)
    // and broadcast, so a newly-owned agent appears without a manual refresh.
    const nextOwnerUserId = agent.ownerUserId ?? null
    if (body.ownerUserId !== undefined && nextOwnerUserId !== existingAgent.ownerUserId) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'agent.owner_changed',
        metadata: {
          nextOwnerUserId,
          previousOwnerUserId: existingAgent.ownerUserId,
        },
        outcome: 'success',
        resourceId: agentId,
        resourceType: 'agent',
      })
      await realtimeHub.publishWs(
        [
          { kind: 'organization', organizationId: actorContext.tenant.organizationId },
          { kind: 'agent', agentId: parseAgentId(agentId) },
        ],
        { data: { agentId: parseAgentId(agentId) }, event: 'agent.updated' },
      )
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
  })

  app.patch('/api/agents/:agentId/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(UpdateAgentAvatarBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const existingAgent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { systemManaged: true },
    })
    if (!existingAgent || !(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    // Same rule as the main edit route: visibility is not edit permission.
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    if (
      body.avatarAttachmentId
      && !(await validateAgentAvatarAttachment({
        actorContext,
        attachmentId: body.avatarAttachmentId,
        deps,
        reply,
      }))
    ) {
      return reply
    }

    const agent = await updateAgentAvatar(
      prisma,
      agentId,
      body.avatarAttachmentId,
      body.avatarAttachmentId
        ? body.avatarBackgroundColor ?? randomAgentAvatarBackgroundColor()
        : body.avatarBackgroundColor,
    )
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
  })

  app.post('/api/agents/:agentId/avatar/generate', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(GenerateAgentAvatarBodySchema, request.body ?? {}, reply)
    if (!body) return reply

    const { agentId } = request.params as { agentId: string }
    const existingAgent = await prisma.agent.findFirst({
      where: { id: agentId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, name: true, role: true, systemPrompt: true },
    })
    if (!existingAgent || !(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    if (!requireOwner(actorContext, reply)) return reply
    if (!deps.sharedModelClient) {
      sendApiError(reply, 503, 'AGENT_AVATAR_GENERATION_UNAVAILABLE', 'The model service is not configured')
      return reply
    }

    try {
      const generated = await generateAgentAvatar({
        actorContext,
        agent: {
          id: existingAgent.id,
          name: body.name ?? existingAgent.name,
          role: body.role ?? existingAgent.role,
          systemPrompt: body.systemPrompt ?? existingAgent.systemPrompt,
        },
        instructions: body.instructions,
        config: deps.config.model,
        fileService: deps.fileService,
        ledgerIdentity: deps.ledgerIdentity,
        modelClient: deps.sharedModelClient,
      })
      return createApiResponse(GeneratedAgentAvatarSchema.parse(generated))
    } catch (error) {
      if (sendAgentAvatarGenerationError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/agents/:agentId/bindings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const body = parseInput(CreateAgentBindingBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const channel = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      body.channelId,
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
        'Agents cannot be bound to the Personal Assistant DM',
      )
      return reply
    }

    const { agentId } = request.params as { agentId: string }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    // Policy check: user must be allowed to bind agents
    const bindDecision = await checkPolicy(prisma, actorContext, 'agent', 'bind', {
      agentId,
      channelId: body.channelId,
    })
    if (!bindDecision.allowed) {
      sendApiError(reply, 403, 'POLICY_DENIED', `Agent binding denied: ${bindDecision.reasonCode}`)
      return reply
    }

    const agent = await bindAgentToChannel(prisma, {
      agentId,
      channelId: body.channelId,
      organizationId: actorContext.tenant.organizationId,
    })
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    if (body.triggerMessageId) {
      await enqueueInvitedAgentMentionReplay(prisma, {
        actorContext,
        agent,
        channelId: body.channelId,
        messageId: body.triggerMessageId,
        organizationId: actorContext.tenant.organizationId,
      })
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
  })

  app.delete('/api/agents/:agentId/bindings/:channelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId, channelId } = request.params as { agentId: string; channelId: string }
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
        'The Personal Assistant DM binding is system managed',
      )
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const unbindDecision = await checkPolicy(prisma, actorContext, 'agent', 'bind', { agentId, channelId })
    if (!unbindDecision.allowed) {
      sendApiError(reply, 403, 'POLICY_DENIED', `Agent unbinding denied: ${unbindDecision.reasonCode}`)
      return reply
    }

    await unbindAgentFromChannel(prisma, {
      agentId,
      channelId,
      organizationId: actorContext.tenant.organizationId,
    })
    return reply.code(204).send()
  })

  app.post('/api/agents/:agentId/clone', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const cloned = await cloneAgentRecord(
      prisma,
      agentId,
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
    )
    if (!cloned) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return reply.code(201).send(createApiResponse(AgentRecordSchema.parse(cloned)))
  })

  app.get('/api/agents/:agentId/status', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const status = await loadAgentStatus(prisma, agentId, { visibility })
    if (!status) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(status)
  })

  app.get('/api/agents/:agentId/activity', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const activity = await loadAgentActivity(prisma, agentId, { visibility })
    if (!activity) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(activity)
  })

  app.get('/api/agents/:agentId/messages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    const query = request.query as { limit?: string; offset?: string }
    const limit = Math.min(Math.max(Number(query.limit ?? '5'), 1), 50)
    const offset = Math.max(Number(query.offset ?? '0'), 0)
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadAgentMessages(prisma, agentId, limit, offset, { visibility }))
  })

  app.get('/api/agents/:agentId/children', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(
      await loadAgentChildren(
        prisma,
        agentId,
        createAgentVisibilityScope(actorContext),
      ),
    )
  })

  app.get('/api/agents/:agentId/runs/:runId/tools', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { agentId, runId } = request.params as { agentId: string; runId: string }
    const visibility = createAgentVisibilityScope(actorContext)
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(await loadRunToolCalls(prisma, agentId, runId, { visibility }))
  })
}
