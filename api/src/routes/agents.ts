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
  generateAgentAvatar,
  generateAvatarForNewAgent,
} from '../services/agent-avatar-generation.js'
import { updateAgentAvatar } from '../services/agent-avatars.js'
import { canAccessAttachment } from '../services/attachments.js'
import {
  AGENT_BINDING_ERROR_CODES,
  AgentBindingError,
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
import { countPausedPrivateAgents } from '../services/private-agent-lifecycle.js'
import {
  assertAgentEditAuthority,
  assertAgentFieldAuthority,
  assertAgentModelSelection,
  ledgerAgentModelCatalogRequestHeaders,
  listAgentModelOptionsForUser,
  randomAgentAvatarBackgroundColor,
} from '@nessie/team-admin'
import { checkPolicy } from '../services/policy.js'
import {
  sendAgentEditAuthorityError,
  sendAgentManagementError,
  sendAgentAvatarGenerationError,
  sendAgentModelCatalogError,
  sendProtectedPolicyError,
} from './agent-route-errors.js'
import type { RouteDeps } from './types.js'
import { registerAgentDocumentRoutes } from './agent-documents.js'

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

  registerAgentDocumentRoutes(app, deps)

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

  // This is intentionally a count-only owner surface. The Members tree needs
  // to signal dormant private automation without turning private agents into
  // an organization-browsable directory.
  app.get('/api/agents/paused-private-count', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const count = await countPausedPrivateAgents(
      prisma,
      actorContext.tenant.organizationId,
    )
    return createApiResponse({ count })
  })

  app.get('/api/agents/models', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    // Two independent sources: the deployment's Ledger catalogue and this
    // person's own linked subscriptions. A Ledger failure must not hide the
    // subscriptions — that would take away the one option still able to run —
    // so the composer resolves them separately and only reports the Ledger
    // error when it produced nothing at all.
    const { ledgerError, options } = await listAgentModelOptionsForUser(prisma, {
      config: deps.config.model,
      ...(process.env.LEDGER_PUBLIC_URL
        ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
        : {}),
      organizationId: actorContext.tenant.organizationId,
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext,
        ledgerIdentity: deps.ledgerIdentity,
      }),
      userId: actorContext.actionContext.effectiveUserId ?? actorContext.actor.actorId,
    })
    if (ledgerError && options.length === 0) {
      return reply.code(503).send({
        error: { code: ledgerError.code, message: ledgerError.message },
      })
    }
    return createApiResponse(AgentModelOptionSchema.array().parse(options))
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
        visibility: body.visibility,
      })
      let modelSubscriptionId: string | null = null
      if (body.model !== undefined || body.provider !== undefined) {
        const selection = await assertAgentModelSelection(prisma, {
          actingUserId: actorContext.actor.actorId,
          config: deps.config.model,
          ...(process.env.LEDGER_PUBLIC_URL
            ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
            : {}),
          model: body.model,
          modelSubscriptionId: body.modelSubscriptionId,
          organizationId: actorContext.tenant.organizationId,
          ownerUserId: actorContext.actor.actorId,
          provider: body.provider,
          requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
            actorContext,
            ledgerIdentity: deps.ledgerIdentity,
          }),
        })
        modelSubscriptionId = selection.modelSubscriptionId
      }
      // The one shared generate-then-attach seam, so a chat-created agent gets
      // the same face this route gives. A failed picture never fails the
      // creation — the agent works without one, and the person can generate one
      // from the detail page.
      const generatedAvatar = await generateAvatarForNewAgent({
        actorContext,
        agent: {
          name: body.name,
          role: body.role ?? 'assistant',
          systemPrompt: body.systemPrompt,
        },
        config: deps.config.model,
        existingAvatarAttachmentId: body.avatarAttachmentId,
        fileService: deps.fileService,
        ledgerIdentity: deps.ledgerIdentity,
        modelClient: deps.sharedModelClient,
        onFailure: (error) => {
          request.log.warn(
            { err: error },
            'agent avatar generation failed; creating the agent without one',
          )
        },
      })
      agent = await createAgentRecord(prisma, {
        modelSubscriptionId,
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
        voiceName: body.voiceName,
        speakingStyle: body.speakingStyle,
        toolPolicy: body.toolPolicy,
        visibility: body.visibility,
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
        id: true,
        model: true,
        modelSubscriptionId: true,
        organizationId: true,
        ownerUserId: true,
        provider: true,
        systemManaged: true,
        todosEnabled: true,
        visibility: true,
      },
    })
    if (
      !existingAgent
      || !(await isAgentAccessibleToActor(actorContext, agentId))
    ) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    // Who may rewrite this agent is decided by the agent's ownership state and
    // the actor's LIVE membership row — not by the organization owner role this
    // route used to demand, which locked every ordinary member out of even the
    // private agent they own themselves.
    //
    // Asked here as well as inside the service so an unauthorized editor is
    // refused BEFORE the billed Ledger model-catalogue call, exactly as the
    // create route validates before spending on avatar generation. The service's
    // own check, taken under the policy lock against the row it writes, remains
    // the authoritative one.
    try {
      await assertAgentFieldAuthority(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        existingAgent,
        {
          ...(body.ownerUserId === undefined ? {} : { ownerUserId: body.ownerUserId }),
          ...(body.todosEnabled === undefined ? {} : { todosEnabled: body.todosEnabled }),
        },
      )
    } catch (error) {
      if (sendAgentEditAuthorityError(reply, error)) return reply
      throw error
    }

    let agent
    try {
      // Validated as the RESULTING pair, not the patch, and against the agent's
      // owner-to-be rather than the editor: a subscription is the owner's to
      // spend. `modelSubscription` is returned explicitly so a Ledger selection
      // clears any previous pointer and the two can never disagree about which
      // lane this agent runs on.
      let modelSubscriptionId: string | null | undefined
      if (body.model !== undefined || body.provider !== undefined) {
        const selection = await assertAgentModelSelection(prisma, {
          actingUserId: actorContext.actor.actorId,
          config: deps.config.model,
          ...(process.env.LEDGER_PUBLIC_URL
            ? { ledgerPublicUrl: process.env.LEDGER_PUBLIC_URL }
            : {}),
          model: body.model ?? existingAgent.model ?? undefined,
          modelSubscriptionId:
            body.modelSubscriptionId ?? existingAgent.modelSubscriptionId ?? undefined,
          organizationId: actorContext.tenant.organizationId,
          ownerUserId:
            body.ownerUserId === undefined
              ? existingAgent.ownerUserId
              : body.ownerUserId,
          provider: body.provider ?? existingAgent.provider ?? undefined,
          requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
            actorContext,
            ledgerIdentity: deps.ledgerIdentity,
          }),
        })
        modelSubscriptionId = selection.modelSubscriptionId
      }
      agent = await updateAgentRecord(
        prisma,
        agentId,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        {
          ...body,
          ...(modelSubscriptionId === undefined ? {} : { modelSubscriptionId }),
          organizationId: actorContext.tenant.organizationId,
        },
      )
    } catch (error) {
      if (sendAgentEditAuthorityError(reply, error)) return reply
      if (sendProtectedPolicyError(reply, error)) return reply
      if (sendAgentManagementError(reply, error)) return reply
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
    // Same rule as the main edit route: seeing an agent is not permission to
    // rewrite it, and being an organization owner is not the only way to have
    // that permission. `updateAgentAvatar` asks `canEditAgent` itself.

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
      agent = await updateAgentAvatar(
        prisma,
        agentId,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        body.avatarAttachmentId,
        body.avatarAttachmentId
          ? body.avatarBackgroundColor ?? randomAgentAvatarBackgroundColor()
          : body.avatarBackgroundColor,
      )
    } catch (error) {
      if (sendAgentEditAuthorityError(reply, error)) return reply
      throw error
    }
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
      select: {
        id: true,
        name: true,
        organizationId: true,
        ownerUserId: true,
        role: true,
        systemManaged: true,
        systemPrompt: true,
        visibility: true,
      },
    })
    if (!existingAgent || !(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    // Generation is billed work on somebody else's agent, so authority is
    // checked before the model call rather than at the PATCH that confirms it.
    try {
      await assertAgentEditAuthority(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        existingAgent,
      )
    } catch (error) {
      if (sendAgentEditAuthorityError(reply, error)) return reply
      throw error
    }
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
    // Every system DM is a single-agent surface (see `bindAgentToChannel`), so
    // the refusal covers all of them, not only the Personal Assistant's.
    if (channel.systemChannelType) {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'Agents cannot be bound to a system-managed conversation',
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

    let agent
    try {
      agent = await bindAgentToChannel(prisma, {
        agentId,
        channelId: body.channelId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        ...(body.confirmBrowserSharing === undefined
          ? {}
          : { confirmBrowserSharing: body.confirmBrowserSharing }),
      })
    } catch (error) {
      if (
        error instanceof AgentBindingError
        && error.code === AGENT_BINDING_ERROR_CODES.PRIVATE_VISIBILITY
      ) {
        sendApiError(reply, 403, error.code, error.message)
        return reply
      }
      if (
        error instanceof AgentBindingError
        && error.code === AGENT_BINDING_ERROR_CODES.BROWSER_LOGINS_PRESENT
      ) {
        // 409, not 403: the caller may proceed, but only after being told
        // what the channel's members would inherit.
        sendApiError(reply, 409, error.code, error.message)
        return reply
      }
      throw error
    }
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
    if (channel.systemChannelType) {
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'System-managed conversation bindings are owned by their bootstrap',
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
