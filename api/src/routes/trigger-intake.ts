import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { verifyHmacSignature } from '@nessie/runtime'
import { type TriggerEventDispatchJobPayload } from '@nessie/schemas'
import {
  AgentTriggerDeliveryRecordSchema,
  PublishEventBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RequestWithRawBody } from '../lib/server-context.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { dispatchAgentTrigger } from '../services/triggers.js'
import type { RouteDeps } from './types.js'

// --- sp-webhook: HMAC signature verification ---------------------------------
// When a webhook trigger carries a `signingSecret`, the intake endpoint requires
// a valid `X-Nessie-Signature` over the RAW request body (HMAC-SHA256) instead
// of the bearer-key check. A `sha256=` prefix is accepted (GitHub-compatible).
// The comparison itself is `@nessie/runtime`'s shared verifier — this used to
// be one of four hand-rolled copies (2026-09-05 review, F5-2).

const SIGNATURE_HEADER = 'x-nessie-signature'

const verifySignedWebhookRequest = (
  request: FastifyRequest,
  signingSecret: string,
): boolean => {
  const headerValue = request.headers[SIGNATURE_HEADER]
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue

  // The JSON content-type parser captures the unparsed buffer on `rawBody`; the
  // HMAC must be computed over those exact bytes, not a re-serialized body.
  const rawBody = (request as RequestWithRawBody).rawBody
  if (!rawBody) {
    return false
  }

  return verifyHmacSignature({
    encoding: 'hex',
    payload: rawBody,
    prefix: 'sha256=',
    secret: signingSecret,
    signature: provided,
  })
}

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
    readFirstHeader,
  } = deps

  // Dispatch a verified webhook to its trigger and write the 202/4xx response.
  // Shared by the bearer-key endpoint and the HMAC-signed endpoint below.
  const dispatchVerifiedWebhook = async (
    request: FastifyRequest,
    reply: FastifyReply,
    triggerId: string,
  ) => {
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
      triggerId,
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
  }

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

    // Look the key up, do not scan for it. This used to load EVERY webhook
    // trigger in the deployment — no tenant filter — and compare the presented
    // key against each one in Node, so an unauthenticated caller could drive an
    // unbounded cross-tenant table scan on demand (2026-09-05 review, FO3-7).
    // The key lives inside `config` JSON, which the writers in
    // `@nessie/team-admin` own, so the lookup is an equality on that JSON path
    // served by the partial expression index added in
    // `20260907120000_agent_trigger_webhook_key_index`. A trigger holding a
    // `signingSecret` is excluded here exactly as before: it MUST use the
    // HMAC-signed endpoint below and bearer-key auth is never accepted for it.
    const matched = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "agent_triggers"
      WHERE "type" = 'webhook'::"AgentTriggerType"
        AND "signing_secret" IS NULL
        AND "config" ->> 'apiKey' = ${apiKey}
      LIMIT 1
    `
    const matchedTrigger = matched[0]

    if (!matchedTrigger) {
      sendApiError(reply, 403, 'WEBHOOK_API_KEY_INVALID', 'Webhook API key is invalid')
      return reply
    }

    return dispatchVerifiedWebhook(request, reply, matchedTrigger.id)
  })

  // sp-webhook: HMAC-signed intake. The trigger is identified by path so its
  // `signingSecret` can be resolved and the signature verified against it.
  app.post(
    '/api/triggers/:triggerId/webhook',
    { config: { public: true } },
    async (request, reply) => {
      if (!isJsonContentType(request)) {
        sendApiError(reply, 415, 'WEBHOOK_CONTENT_TYPE_INVALID', 'Webhook requests must use JSON')
        return reply
      }

      const { triggerId } = request.params as { triggerId: string }
      const trigger = await prisma.agentTrigger.findFirst({
        where: { id: triggerId, type: 'webhook' },
        select: { id: true, signingSecret: true },
      })

      if (!trigger || !trigger.signingSecret) {
        sendApiError(reply, 404, 'WEBHOOK_TRIGGER_NOT_FOUND', 'Signed webhook trigger not found')
        return reply
      }

      if (!verifySignedWebhookRequest(request, trigger.signingSecret)) {
        sendApiError(reply, 401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is missing or invalid')
        return reply
      }

      return dispatchVerifiedWebhook(request, reply, trigger.id)
    },
  )

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
      source: `event:${body.eventType}`,
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
