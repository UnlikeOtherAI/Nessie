import type { FastifyInstance } from 'fastify'

import {
  AgentModelOptionSchema,
  AgentRecordSchema,
  CreateAgentBindingBodySchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  UpdateAgentAvatarBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
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
} from '../services/agents.js'
import {
  assertLedgerAgentModelSelection,
  ledgerAgentModelCatalogRequestHeaders,
  listLedgerAgentModels,
} from '@nessie/workspace-admin'
import { checkPolicy } from '../services/policy.js'
import {
  sendAgentManagementError,
  sendAgentModelCatalogError,
  sendProtectedPolicyError,
} from './agent-route-errors.js'
import type { RouteDeps } from './types.js'

export const registerAgentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
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
    const agents = await listAgentsForUser(
      prisma,
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      isOwner,
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

    let agent
    try {
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
      agent = await createAgentRecord(prisma, {
        effort: body.effort,
        model: body.model,
        name: body.name,
        organizationId: actorContext.tenant.organizationId,
        parentAgentId: body.parentAgentId,
        projectId: actorContext.tenant.projectId,
        provider: body.provider,
        role: body.role ?? 'assistant',
        runLimits: body.runLimits,
        systemPrompt: body.systemPrompt,
        teamId: actorContext.tenant.teamId,
        toolPolicy: body.toolPolicy,
      })
    } catch (error) {
      if (sendProtectedPolicyError(reply, error)) return reply
      if (sendAgentManagementError(reply, error)) return reply
      if (sendAgentModelCatalogError(reply, error)) return reply
      throw error
    }

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

    if (body.avatarAttachmentId) {
      const attachment = await prisma.attachment.findUnique({
        where: { id: body.avatarAttachmentId },
      })
      if (
        !attachment ||
        !(await canAccessAttachment(prisma, attachment, {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        }))
      ) {
        sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
        return reply
      }
      if (attachment.kind !== 'image') {
        sendApiError(reply, 400, 'INVALID_AVATAR', 'Avatar must be an image')
        return reply
      }
    }

    const agent = await updateAgentAvatar(prisma, agentId, body.avatarAttachmentId)
    if (!agent) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    return createApiResponse(AgentRecordSchema.parse(agent))
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
        actorContext.tenant.organizationId,
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
