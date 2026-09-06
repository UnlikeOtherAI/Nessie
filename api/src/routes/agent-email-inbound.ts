import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  resolveAgentMailReadiness,
  verifySnsMessage,
  type SnsVerificationFailure,
} from '@nessie/agent-mail'
import { AGENT_EMAIL_INBOUND_TOPIC } from '@nessie/schemas'
import { safeFetch } from '@nessie/runtime'

import { enqueueQueueJob } from '@nessie/db'
import { sendApiError } from '../lib/api.js'
import type { RequestWithRawBody } from '../lib/server-context.js'
import type { RouteDeps } from './types.js'

/**
 * The public inbound endpoint for hosted agent mail.
 *
 * Amazon SNS delivers both inbound receipts (from the SES receipt rule) and
 * bounce/complaint/delivery events (from the configuration set) here. Three
 * checks gate every one of them, and all three must pass:
 *
 *  1. a valid signature under a certificate fetched from a host-pinned Amazon
 *     URL (through `safeFetch`, so the fetch itself is IP-pinned);
 *  2. a `TopicArn` equal to the configured topic — any AWS customer can produce
 *     a genuinely Amazon-signed message from *their* topic, so a signature
 *     alone proves nothing about who sent it;
 *  3. a recognised SES payload shape, decided in the worker.
 *
 * `SubscriptionConfirmation` is refused outright: the API subscribes itself to
 * the configured topic at startup, so a confirmation arriving here is either
 * unnecessary or a stranger probing for a live endpoint.
 *
 * Verification happens synchronously and the request is *not* acked when it
 * fails — an unverified caller learns nothing about whether this deployment
 * handles mail.
 */

const MAX_BODY_BYTES = 512 * 1024

const readRawBody = (request: FastifyRequest): string => {
  const raw = (request as RequestWithRawBody).rawBody
  if (raw) return raw.toString('utf8')
  if (typeof request.body === 'string') return request.body
  return JSON.stringify(request.body ?? {})
}

/** One process-lifetime cache so a burst of deliveries fetches the cert once. */
const certificateCache = new Map<string, string>()

const fetchCertificate = async (url: string): Promise<{ ok: boolean; text(): Promise<string> }> => {
  const response = await safeFetch(url, { method: 'GET' })
  return {
    ok: response.ok,
    text: () => response.text(),
  }
}

export const registerAgentEmailInboundRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma } = deps

  app.post(
    '/api/integrations/email/inbound',
    { config: { public: true } },
    async (request, reply) => {
      const readiness = resolveAgentMailReadiness(deps.config.email)
      if (!readiness.ready) {
        // Nothing is configured to receive mail here. Say so plainly rather
        // than accepting deliveries into a void.
        sendApiError(
          reply,
          503,
          'AGENT_EMAIL_UNCONFIGURED',
          'Agent mail is not configured for this deployment.',
        )
        return reply
      }

      const rawBody = readRawBody(request)
      if (rawBody.length > MAX_BODY_BYTES) {
        sendApiError(
          reply,
          413,
          'PAYLOAD_TOO_LARGE',
          'Request body exceeds the maximum allowed size.',
        )
        return reply
      }

      const verified = await verifySnsMessage({
        certificateCache,
        expectedTopicArn: readiness.config.snsTopicArn,
        fetchCertificate,
        rawBody,
      })

      if (!verified.ok) {
        request.log.warn(
          { reason: verified.reason },
          'agent email inbound: SNS verification failed',
        )
        return reply.code(statusForFailure(verified.reason)).send({ error: verified.reason })
      }

      try {
        await enqueueQueueJob(prisma, {
          // SNS retries on any non-2xx, so the queue's own idempotency key plus
          // the worker's receipt-id claim make a replay a no-op rather than a
          // second delivery.
          idempotencyKey: `agent-email:sns:${verified.envelope.MessageId}`,
          payload: {
            receivedAt: new Date().toISOString(),
            sesPayload: verified.envelope.Message,
            snsMessageId: verified.envelope.MessageId,
          },
          topic: AGENT_EMAIL_INBOUND_TOPIC,
        })
      } catch (error) {
        // Fail loudly to SNS: it retries, and a dropped delivery is lost mail.
        request.log.error({ err: error }, 'agent email inbound enqueue failed')
        sendApiError(reply, 500, 'ENQUEUE_FAILED', 'Failed to enqueue the inbound message.')
        return reply
      }

      return reply.code(200).send({ ok: true })
    },
  )
}

const statusForFailure = (reason: SnsVerificationFailure): number => {
  switch (reason) {
    case 'malformed':
    case 'unsupported_type':
    case 'unsupported_signature_version':
      return 400
    case 'certificate_fetch_failed':
      return 502
    default:
      // topic_mismatch, signature_invalid, certificate_url_rejected,
      // stale_timestamp — all "not ours", answered identically.
      return 403
  }
}
