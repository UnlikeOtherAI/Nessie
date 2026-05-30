import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import { type TriggerEventDispatchJobPayload } from '@nessie/schemas'
import {
  AgentTriggerDeliveryRecordSchema,
  PublishEventBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { dispatchAgentTrigger } from '../services/triggers.js'
import type { RouteDeps } from './types.js'

/**
 * Inbound trigger intake: the public webhook receiver and the authenticated
 * event-publish endpoint. Split from `./triggers.ts` (trigger CRUD + lifecycle)
 * to keep each file under the 500-line cap (AGENTS.md). Registration order is
 * preserved by the caller in `triggers.ts`.
 */
export const registerTriggerIntakeRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireOwner,
    readWebhookApiKey,
    isJsonContentType,
    isTimingSafeMatch,
    readFirstHeader,
  } = deps

  app.post('/api/triggers/webhook', { config: { public: true } }, async (request, reply) => {
    const apiKey = readWebhookApiKey(request)
    if (!apiKey) {
      sendApiError(reply, 401, 'WEBHOOK_API_KEY_REQUIRED', 'Webhook API key missing')
      return reply
    }

    if (!isJsonContentType(request)) {
      sendApiError(reply, 415, 'WEBHOOK_CONTENT_TYPE_INVALID', 'Webhook requests must use JSON')
      return reply
    }

    const candidateTriggers = await prisma.agentTrigger.findMany({
      where: {
        type: 'webhook',
      },
      select: {
        id: true,
        config: true,
      },
    })

    const matchedTrigger = candidateTriggers.find((candidate) => {
      const candidateApiKey =
        candidate.config &&
        typeof candidate.config === 'object' &&
        !Array.isArray(candidate.config) &&
        typeof (candidate.config as Record<string, unknown>)['apiKey'] === 'string'
          ? ((candidate.config as Record<string, unknown>)['apiKey'] as string)
          : undefined

      return isTimingSafeMatch(candidateApiKey, apiKey)
    })

    if (!matchedTrigger) {
      sendApiError(reply, 403, 'WEBHOOK_API_KEY_INVALID', 'Webhook API key is invalid')
      return reply
    }

    const dedupeKey =
      readFirstHeader(request, [
        'x-nessie-delivery-id',
        'x-github-delivery',
        'x-request-id',
      ]) ?? randomUUID()

    const dispatched = await dispatchAgentTrigger(prisma, {
      dedupeKey,
      payload: request.body,
      source: 'webhook',
      triggerId: matchedTrigger.id,
    })

    if (dispatched.kind === 'rejected') {
      if (dispatched.reason === 'agent_not_bound') {
        sendApiError(reply, 409, 'AGENT_NOT_BOUND', 'Agent must be bound to a channel before firing')
        return reply
      }

      sendApiError(reply, 409, 'TRIGGER_UNAVAILABLE', 'Trigger is not available for execution')
      return reply
    }

    return reply.code(202).send(
      createApiResponse({
        accepted: true,
        delivery: AgentTriggerDeliveryRecordSchema.parse(dispatched.delivery),
        existing: dispatched.existing,
        runId: dispatched.runId,
      }),
    )
  })

  app.post('/api/events', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(PublishEventBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const payload: TriggerEventDispatchJobPayload = {
      actorContext,
      dedupeKey: body.dedupeKey,
      eventType: body.eventType,
      payload: body.payload ?? {},
      source: body.source ?? `event:${body.eventType}`,
    }
    const queueIdempotencyKey = payload.dedupeKey
      ? `trigger-event:${actorContext.tenant.organizationId}:${payload.dedupeKey}`
      : undefined

    const enqueued = await enqueueQueueJob(prisma, {
      idempotencyKey: queueIdempotencyKey,
      payload,
      topic: 'trigger.event.dispatch',
    })

    return reply.code(202).send(
      createApiResponse({
        accepted: enqueued,
        eventType: payload.eventType,
        existing: !enqueued,
        source: payload.source,
      }),
    )
  })
}
