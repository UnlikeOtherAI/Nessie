import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { assertAgentEditAuthority } from '@nessie/team-admin'

import {
  ConfirmLocalInferenceBindingBodySchema,
  LocalInferenceBindingStatusResponseSchema,
  PrepareLocalInferenceBindingBodySchema,
} from '../contracts/local-inference.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  confirmLocalInferenceBinding,
  LocalInferenceBindingError,
  prepareLocalInferenceBinding,
} from '../services/local-inference-bindings.js'
import type { RouteDeps } from './types.js'

const HostIdParamsSchema = z.object({ hostId: z.string().uuid() })
const AgentIdParamsSchema = z.object({ agentId: z.string().uuid() })
const BindingStatusParamsSchema = AgentIdParamsSchema.extend({ bindingId: z.string().uuid() })

const sendBindingError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof LocalInferenceBindingError)) return false
  const status = error.code === 'NOT_FOUND' ? 404
    : error.code === 'ENTITLEMENT_UNAVAILABLE' ? 503
      : error.code.endsWith('CONFLICT') || error.code === 'CHALLENGE_INVALID' ? 409
        : 403
  sendApiError(reply, status, error.code, error.message)
  return true
}

/** Browser preparation and signed native consent, with Save deliberately absent. */
export const registerLocalInferenceConsentRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  app.post('/api/agents/:agentId/local-inference/prepare', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const params = parseInput(AgentIdParamsSchema, request.params, reply, 'params')
    const body = parseInput(PrepareLocalInferenceBindingBodySchema, request.body, reply)
    if (!params || !body) return reply
    const agent = await prisma.agent.findFirst({
      where: { id: params.agentId, organizationId: actor.tenant.organizationId, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true, systemManaged: true, visibility: true },
    })
    if (!agent) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Agent not found.')
      return reply
    }
    try {
      await assertAgentEditAuthority(prisma, {
        organizationId: actor.tenant.organizationId,
        uoaIdentity: actor.actionContext.uoaIdentity,
        userId: actor.actor.actorId,
      }, agent)
      const prepared = await prepareLocalInferenceBinding(prisma, {
        agentId: agent.id,
        ...(actor.actionContext.uoaIdentity
          ? {
            editorUoaIdentity: {
              subject: actor.actionContext.uoaIdentity.subject,
              tokenVersion: actor.actionContext.uoaIdentity.tokenVersion,
            },
          }
          : {}),
        editorUserId: actor.actor.actorId,
        hostId: body.hostId,
        manifestDigest: body.manifestDigest,
        modelName: body.modelName,
        organizationId: actor.tenant.organizationId,
      })
      reply.header('Cache-Control', 'no-store')
      return createApiResponse({
        bindingId: prepared.bindingId,
        challengeId: prepared.challengeId,
        expiresAt: prepared.expiresAt.toISOString(),
      })
    } catch (error) {
      if (sendBindingError(reply, error)) return reply
      throw error
    }
  })

  // The signed machine consent is addressed to the exact agent, not merely the
  // host. The server derives the host solely from the prepared one-use
  // challenge and Save remains the only activation commit.
  app.post('/api/agents/:agentId/local-inference/confirm', { config: { public: true } }, async (request, reply) => {
    const params = parseInput(AgentIdParamsSchema, request.params, reply, 'params')
    const body = parseInput(ConfirmLocalInferenceBindingBodySchema, request.body, reply)
    if (!params || !body) return reply
    try {
      reply.header('Cache-Control', 'no-store')
      return createApiResponse(await confirmLocalInferenceBinding(prisma, {
        agentId: params.agentId,
        challengeId: body.challengeId,
        signature: body.signature,
      }))
    } catch (error) {
      if (sendBindingError(reply, error)) return reply
      throw error
    }
  })

  // The executor confirms out of band. The Designer is allowed to select the
  // resulting binding only after this owner-authorized read observes the exact
  // server transition; a local button or copied command output cannot do it.
  app.get('/api/agents/:agentId/local-inference/bindings/:bindingId/status', async (request, reply) => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return reply
    const params = parseInput(BindingStatusParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const agent = await prisma.agent.findFirst({
      where: { id: params.agentId, organizationId: actor.tenant.organizationId, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true, systemManaged: true, visibility: true },
    })
    if (!agent) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Agent not found.')
      return reply
    }
    try {
      await assertAgentEditAuthority(prisma, {
        organizationId: actor.tenant.organizationId,
        uoaIdentity: actor.actionContext.uoaIdentity,
        userId: actor.actor.actorId,
      }, agent)
    } catch {
      sendApiError(reply, 403, 'FORBIDDEN', 'You cannot edit this agent.')
      return reply
    }
    const binding = await prisma.agentLocalInferenceBinding.findFirst({
      where: {
        agentId: agent.id,
        id: params.bindingId,
        organizationId: actor.tenant.organizationId,
      },
      select: { id: true, status: true },
    })
    if (!binding) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Local model approval not found.')
      return reply
    }
    reply.header('Cache-Control', 'no-store')
    return createApiResponse(LocalInferenceBindingStatusResponseSchema.parse({
      bindingId: binding.id,
      status: binding.status,
    }))
  })

  // Compatibility for the headless executor command. It is equally
  // machine-signed and cannot activate a lane; new direct Desktop code uses
  // the canonical agent path above.
  app.post('/api/local-inference/hosts/:hostId/confirm', async (request, reply) => {
    const params = parseInput(HostIdParamsSchema, request.params, reply, 'params')
    const body = parseInput(ConfirmLocalInferenceBindingBodySchema, request.body, reply)
    if (!params || !body) return reply
    try {
      return createApiResponse(await confirmLocalInferenceBinding(prisma, {
        challengeId: body.challengeId,
        hostId: params.hostId,
        signature: body.signature,
      }))
    } catch (error) {
      if (sendBindingError(reply, error)) return reply
      throw error
    }
  })

  for (const action of ['pause', 'resume', 'revoke'] as const) {
    app.post(`/api/local-inference/hosts/:hostId/${action}`, async (request, reply) => {
      const actor = requireActorContext(request, reply)
      if (!actor || !requireUserActor(actor, reply)) return reply
      const params = parseInput(HostIdParamsSchema, request.params, reply, 'params')
      if (!params) return reply
      const where = {
        custodianUserId: actor.actor.actorId,
        id: params.hostId,
        organizationId: actor.tenant.organizationId,
      }
      const data = action === 'pause'
        ? { pausedAt: new Date() }
        : action === 'resume'
          ? { pausedAt: null }
          : { authorizationRevision: { increment: 1 }, revokedAt: new Date() }
      const updated = await prisma.localInferenceHost.updateMany({ where, data })
      if (updated.count === 0) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Local host not found.')
        return reply
      }
      if (action === 'revoke') {
        await prisma.agentLocalInferenceBinding.updateMany({
          where: { hostId: params.hostId, status: { in: ['active', 'consented_pending_activation', 'pending'] } },
          data: { reason: 'host_revoked', status: 'revoked' },
        })
      }
      return createApiResponse({ ok: true })
    })
  }
}
