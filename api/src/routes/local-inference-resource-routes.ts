import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  LocalInferenceResourceAttachmentSchema, LocalInferenceSignedEnvelopeSchema, LocalInferenceTerminationSchema,
} from '@nessie/schemas'
import { settleLocalInferenceAttemptAdmission } from '@nessie/runtime'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { authenticateLocalInferenceDaemonEnvelope } from '../services/local-inference-daemon-intake.js'
import { attachLocalInferenceResource, setLocalInferenceResourceCapacity } from '../services/local-inference-resource.js'
import type { RouteDeps } from './types.js'

const ResourceBody = z.object({
  envelope: LocalInferenceSignedEnvelopeSchema,
  resource: z.object({
    attachment: LocalInferenceResourceAttachmentSchema,
    controlRevision: z.number().int().nonnegative(),
    paused: z.boolean(), healthReason: z.enum(['termination_uncertain']).nullable(),
    action: z.enum(['pause', 'resume']).optional(),
  }).strict(),
}).strict()
const TerminationBody = z.object({
  envelope: LocalInferenceSignedEnvelopeSchema, termination: LocalInferenceTerminationSchema,
}).strict()

export const registerLocalInferenceResourceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.post('/api/local-inference/hosts/:hostId/capacity', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const params = parseInput(z.object({ hostId: z.string().uuid() }), request.params, reply, 'params')
    const body = parseInput(z.object({ capacity: z.number().int().min(1).max(16) }).strict(), request.body, reply)
    if (!params || !body) return reply
    const updated = await deps.prisma.$transaction((tx) => setLocalInferenceResourceCapacity(tx, {
      capacity: body.capacity, custodianUserId: actor.actor.actorId,
      hostId: params.hostId, organizationId: actor.tenant.organizationId,
    }))
    if (!updated) {
      sendApiError(reply, 404, 'NOT_FOUND', 'An enrolled local resource owned by you was not found.')
      return reply
    }
    return createApiResponse({ ok: true })
  })

  app.post('/api/local-inference/daemon/resource', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(ResourceBody, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(deps.prisma, {
      body: body.resource, envelope: body.envelope, purpose: 'resource',
    })
    const resource = daemon && await deps.prisma.$transaction(async (tx) => {
      if (!await daemon.stillAuthorized(tx)) return null
      return attachLocalInferenceResource(tx, { ...body.resource, host: daemon.authorization.host })
    })
    if (!resource) {
      sendApiError(reply, 409, 'LOCAL_RESOURCE_UNAVAILABLE', 'The local inference resource needs enrollment or repair.')
      return reply
    }
    return createApiResponse(resource)
  })

  app.post('/api/local-inference/daemon/attempts/termination', { config: { public: true } }, async (request, reply) => {
    const body = parseInput(TerminationBody, request.body, reply)
    if (!body) return reply
    const daemon = await authenticateLocalInferenceDaemonEnvelope(deps.prisma, {
      body: body.termination, envelope: body.envelope, purpose: 'termination',
    })
    const settled = daemon && await deps.prisma.$transaction(async (tx) => {
      if (!await daemon.stillAuthorized(tx)) return false
      const host = await tx.localInferenceHost.findFirst({
        where: { id: daemon.hostId, inferenceResourceId: body.termination.resourceId }, select: { id: true },
      })
      if (!host) return false
      // A sibling transport proves the same enrolled resource and may replay
      // its coordinator's durable confirmation after the original host exits.
      return settleLocalInferenceAttemptAdmission(tx, body.termination)
    })
    if (!settled) {
      sendApiError(reply, 409, 'LOCAL_RESOURCE_FENCED', 'The local inference admission is no longer current.')
      return reply
    }
    return createApiResponse({ acknowledged: true })
  })
}
