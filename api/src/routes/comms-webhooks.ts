import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { COMMS_WEBHOOK_PROCESS_TOPIC, type CommsProvider } from '@nessie/schemas'

import { enqueueQueueJob } from '../queue/pgqueue.js'
import type { RequestWithRawBody } from '../lib/server-context.js'
import type { RouteDeps } from './types.js'

/**
 * Public (unauthenticated) inbound provider webhooks for the Individual
 * Communications Connector. These handlers are deliberately minimal: they
 * answer the provider fast (always 200 to avoid retry storms), snapshot the raw
 * bytes + headers, and hand off to the `comms.webhook.process` worker job which
 * resolves the connector, verifies the signature, normalizes, and persists.
 *
 * Slack's URL-verification challenge is the one thing answered synchronously
 * here (Slack expects the `challenge` echoed on the same request); full request
 * signature verification still happens in the worker connector.
 */

const flattenHeaders = (request: FastifyRequest): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(',')
    }
  }
  return headers
}

const flattenQuery = (request: FastifyRequest): Record<string, string> => {
  const query: Record<string, string> = {}
  const raw = request.query as Record<string, unknown>
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') {
      query[key] = value
    }
  }
  return query
}

const readRawBody = (request: FastifyRequest): string => {
  const raw = (request as RequestWithRawBody).rawBody
  if (raw) return raw.toString('utf8')
  if (typeof request.body === 'string') return request.body
  return JSON.stringify(request.body ?? {})
}

export const registerCommsWebhookRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma } = deps

  const handleDelivery = async (
    request: FastifyRequest,
    reply: FastifyReply,
    provider: CommsProvider,
  ): Promise<FastifyReply> => {
    try {
      await enqueueQueueJob(prisma, {
        topic: COMMS_WEBHOOK_PROCESS_TOPIC,
        payload: {
          provider,
          headers: flattenHeaders(request),
          query: flattenQuery(request),
          rawBody: readRawBody(request),
          receivedAt: new Date().toISOString(),
        },
      })
    } catch (error) {
      // Never fail the provider: the reconciliation sweep recovers a dropped
      // delivery. Log and still ack.
      request.log.error({ err: error, provider }, 'comms webhook enqueue failed')
    }
    return reply.code(200).send({ ok: true })
  }

  // ── POST /api/comms/webhooks/slack ────────────────────────────────────────
  app.post(
    '/api/comms/webhooks/slack',
    { config: { public: true } },
    async (request, reply) => {
      const body = request.body as { type?: string; challenge?: string } | undefined
      if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
        return reply.code(200).send({ challenge: body.challenge })
      }
      return handleDelivery(request, reply, 'slack')
    },
  )

  // ── POST /api/comms/webhooks/google ───────────────────────────────────────
  app.post(
    '/api/comms/webhooks/google',
    { config: { public: true } },
    async (request, reply) => handleDelivery(request, reply, 'google'),
  )
}
