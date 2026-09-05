import type { FastifyInstance } from 'fastify'

import {
  AgentTriggerActivityRecordSchema,
  AgentTriggerDeliveryRecordSchema,
  AgentTriggerRecordSchema,
  CreateAgentTriggerBodySchema,
  FireAgentTriggerBodySchema,
  UpdateAgentTriggerBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { checkPolicy } from '../services/policy.js'
import {
  createAgentTrigger,
  deleteAgentTrigger,
  dispatchAgentTrigger,
  getAgentTrigger,
  listAgentTriggerActivity,
  listAgentTriggerDeliveries,
  listAgentTriggers,
  listOrganizationTriggers,
  listScheduledTriggers,
  updateAgentTrigger,
} from '../services/triggers.js'
import { registerTriggerIntakeRoutes } from './trigger-intake.js'
import { registerTriggerLifecycleRoutes } from './trigger-lifecycle.js'
import type { RouteDeps } from './types.js'
import { loadLedgerIdentitySettings } from '@nessie/runtime'
import { captureScheduledLaunchOrigin } from '@nessie/team-admin'

// Read once at startup, exactly like the runtime signer itself: whether this
// deployment signs Ledger calls is never a per-request or per-user decision.
const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null

export const registerTriggerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    requireUserActor,
    isAgentAccessibleToActor,
    isTriggerAccessibleToActor,
    isTriggerTargetWritableByActor,
    parseHeaderValue,
  } = deps

  app.get('/api/agents/:agentId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const triggers = await listAgentTriggers(prisma, agentId)
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  // What those triggers are doing right now, read separately from the records
  // themselves: configuration and run state have different lifetimes, and a
  // client refetches this one on a live cadence without re-reading the config.
  // Same gates as the list above, no weaker.
  app.get('/api/agents/:agentId/triggers/activity', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const activity = await listAgentTriggerActivity(prisma, agentId)
    return createApiResponse(AgentTriggerActivityRecordSchema.array().parse(activity))
  })

  app.post('/api/agents/:agentId/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { agentId } = request.params as { agentId: string }
    if (!(await isAgentAccessibleToActor(actorContext, agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }

    const body = parseInput(CreateAgentTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const isScheduled = body.type === 'scheduled' || body.type === 'interval'
    if (isScheduled && !requireUserActor(actorContext, reply)) {
      return reply
    }

    // Shared with `POST /api/triggers/:id/reauthorize`, which must capture the
    // identity exactly as creation does — a second copy would be free to drift,
    // and drift here means schedules that authenticate differently depending on
    // which door they came through.
    const captured = isScheduled
      ? captureScheduledLaunchOrigin({ actorContext, ledgerSigningConfigured })
      : null
    if (captured?.kind === 'no_team') {
      sendApiError(
        reply,
        400,
        'TRIGGER_LAUNCH_ORIGIN_REQUIRED',
        'Scheduled triggers require an authenticated user with an active team.',
      )
      return reply
    }
    // A signing deployment cannot fire a schedule whose creator left no UOA
    // identity: it would mint a trigger that fails at every sweep forever.
    // Refuse now, while there is somebody to tell.
    if (captured?.kind === 'no_uoa_identity') {
      sendApiError(
        reply,
        400,
        'TRIGGER_UOA_IDENTITY_REQUIRED',
        'Scheduled triggers require an UnlikeOtherAI SSO session. Sign in through SSO and create the schedule again.',
      )
      return reply
    }
    const launchOrigin =
      captured?.kind === 'captured' ? captured.launchOrigin : undefined

    const trigger = await createAgentTrigger(
      prisma,
      agentId,
      body,
      launchOrigin ? { launchOrigin } : {},
    )
    if (!trigger) {
      sendApiError(reply, 400, 'TRIGGER_INVALID', 'Trigger configuration is invalid')
      return reply
    }

    // Arming an automation decides what runs unattended, on whose identity and
    // how often — audited like every other privileged mutation, alongside
    // update/delete/fire and the lifecycle transitions.
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'trigger.created',
      resourceType: 'agent_trigger',
      resourceId: trigger.id,
      outcome: 'success',
      metadata: { agentId, type: body.type },
    })

    return reply.code(201).send(createApiResponse(AgentTriggerRecordSchema.parse(trigger)))
  })

  app.put('/api/triggers/:triggerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const scope = {
      organizationId: actorContext.tenant.organizationId,
      triggerId,
    }
    const trigger = await getAgentTrigger(prisma, scope)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const body = parseInput(UpdateAgentTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const updated = await updateAgentTrigger(prisma, scope, body)
    if (!updated) {
      sendApiError(reply, 400, 'TRIGGER_INVALID', 'Trigger configuration is invalid')
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'trigger.updated',
      resourceType: 'agent_trigger',
      resourceId: triggerId,
      outcome: 'success',
      metadata: { fields: Object.keys(body) },
    })

    return createApiResponse(AgentTriggerRecordSchema.parse(updated))
  })

  app.delete('/api/triggers/:triggerId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const scope = {
      organizationId: actorContext.tenant.organizationId,
      triggerId,
    }
    const trigger = await getAgentTrigger(prisma, scope)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const deleted = await deleteAgentTrigger(prisma, scope)
    if (!deleted) {
      sendApiError(
        reply,
        409,
        'TRIGGER_DELETE_BLOCKED',
        'Trigger with delivery history cannot be deleted',
      )
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'trigger.deleted',
      resourceType: 'agent_trigger',
      resourceId: triggerId,
      outcome: 'success',
    })

    return reply.code(204).send()
  })

  app.post('/api/triggers/:triggerId/fire', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireUserActor(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const scope = {
      organizationId: actorContext.tenant.organizationId,
      triggerId,
    }
    const trigger = await getAgentTrigger(prisma, scope)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerTargetWritableByActor(actorContext, trigger))) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Trigger target is not writable by this actor')
      return reply
    }

    const body = parseInput(FireAgentTriggerBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const dedupeKey =
      body.dedupeKey?.trim() || parseHeaderValue(request.headers['idempotency-key'])
    if (!dedupeKey) {
      sendApiError(
        reply,
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Manual trigger fire requires a dedupe key or Idempotency-Key header',
      )
      return reply
    }

    if (trigger.agentId) {
      const invokeDecision = await checkPolicy(prisma, actorContext, 'agent', 'invoke', {
        agentId: trigger.agentId,
      })
      if (!invokeDecision.allowed) {
        sendApiError(
          reply,
          403,
          'POLICY_DENIED',
          `Trigger fire denied: ${invokeDecision.reasonCode}`,
        )
        return reply
      }
    }

    const dispatched = await dispatchAgentTrigger(prisma, {
      actorContext,
      dedupeKey,
      payload: body.payload,
      prompt: body.prompt,
      source: 'manual',
      triggerId,
    })

    if (dispatched.kind === 'rejected') {
      if (dispatched.reason === 'agent_not_bound') {
        sendApiError(reply, 409, 'AGENT_NOT_BOUND', 'Agent must be bound to a channel before firing')
        return reply
      }
      if (dispatched.reason === 'workflow_installation_not_ready') {
        sendApiError(
          reply,
          409,
          'WORKFLOW_INSTALLATION_NOT_READY',
          'Workflow installation is not active',
        )
        return reply
      }

      sendApiError(reply, 409, 'TRIGGER_UNAVAILABLE', 'Trigger is not available for execution')
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'trigger.fired',
      resourceType: 'agent_trigger',
      resourceId: triggerId,
      outcome: 'success',
      metadata: { existing: dispatched.existing, runId: dispatched.runId, source: 'manual' },
    })

    return reply.code(202).send(
      createApiResponse({
        delivery: AgentTriggerDeliveryRecordSchema.parse(dispatched.delivery),
        existing: dispatched.existing,
        runId: dispatched.runId,
        trigger: AgentTriggerRecordSchema.parse(dispatched.trigger),
        workflowRunId: dispatched.workflowRunId,
      }),
    )
  })

  app.get('/api/triggers/:triggerId/history', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { triggerId } = request.params as { triggerId: string }
    const scope = {
      organizationId: actorContext.tenant.organizationId,
      triggerId,
    }
    const trigger = await getAgentTrigger(prisma, scope)
    if (!trigger) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    if (!(await isTriggerAccessibleToActor(actorContext, trigger))) {
      sendApiError(reply, 404, 'TRIGGER_NOT_FOUND', 'Trigger not found')
      return reply
    }

    const rawLimit = (request.query as { limit?: string }).limit
    const parsedLimit = rawLimit === undefined ? 20 : Number.parseInt(rawLimit, 10)
    if (Number.isNaN(parsedLimit)) {
      sendApiError(reply, 400, 'INVALID_LIMIT', 'limit must be an integer')
      return reply
    }
    const limit = Math.min(Math.max(parsedLimit, 1), 100)

    const deliveries = await listAgentTriggerDeliveries(prisma, scope, limit)
    return createApiResponse(AgentTriggerDeliveryRecordSchema.array().parse(deliveries))
  })

  app.get('/api/triggers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const triggers = await listOrganizationTriggers(
      prisma,
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
    )
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.get('/api/triggers/scheduled', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const rawLimit = (request.query as { limit?: string }).limit
    const parsedLimit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10)
    if (Number.isNaN(parsedLimit)) {
      sendApiError(reply, 400, 'INVALID_LIMIT', 'limit must be an integer')
      return reply
    }

    const triggers = await listScheduledTriggers(prisma, {
      organizationId: actorContext.tenant.organizationId,
      limit: Math.min(Math.max(parsedLimit, 1), 200),
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  app.get('/api/triggers/upcoming', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const rawLimit = (request.query as { limit?: string }).limit
    const parsedLimit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10)
    if (Number.isNaN(parsedLimit)) {
      sendApiError(reply, 400, 'INVALID_LIMIT', 'limit must be an integer')
      return reply
    }

    const triggers = await listScheduledTriggers(prisma, {
      dueBefore: new Date(),
      organizationId: actorContext.tenant.organizationId,
      limit: Math.min(Math.max(parsedLimit, 1), 200),
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(AgentTriggerRecordSchema.array().parse(triggers))
  })

  // Inbound intake (public webhook + authenticated event publish) is split into
  // its own module to keep this file under the 500-line cap. Registered last to
  // preserve the original route ordering.
  registerTriggerLifecycleRoutes(app, deps)
  registerTriggerIntakeRoutes(app, deps)
}
