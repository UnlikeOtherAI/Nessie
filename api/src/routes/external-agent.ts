import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { enqueueQueueJob } from '@nessie/db'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import { attributionFromActorContext } from '@nessie/runtime'
import {
  DEEPSIGNAL_INSIGHT_FANOUT_TOPIC,
  isAdminActor,
} from '@nessie/schemas'
import {
  DEEPSIGNAL_SLUG,
  resolveEnabledExternalTeam,
  resolveInsightId,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RequestWithRawBody } from '../lib/server-context.js'
import {
  ExternalAgentSyncError,
  EXTERNAL_AGENT_SYNC_ERROR_CODES,
  syncExternalAgentChannel,
} from '../services/external-agent-sync.js'
import {
  ProductWebhookSecretError,
  resolveSignedWebhookOrg,
  setProductWebhookSecret,
} from '../services/product-webhook-secret.js'
import type { RouteDeps } from './types.js'

/**
 * External-agent history hydration + proactive-insight delivery (DeepSignal
 * integration plan §6). Three surfaces:
 *   - `POST /api/channels/:channelId/external-sync` — pull DeepSignal history
 *     into the channel (member-gated).
 *   - `PUT  /api/integrations/products/:productSlug/webhook-secret` — org admin
 *     sets the per-org inbound-webhook signing secret.
 *   - `POST /api/integrations/deepsignal/events` — unauthenticated, HMAC-verified
 *     receiver for `insight.surfaced`. It verifies, decides whether the event
 *     routes anywhere at all, and enqueues `deepsignal.insight.fanout`; the
 *     per-recipient digest work runs in the worker
 *     (docs/standards/horizontal-scaling.md § 3).
 */

const ChannelIdParamsSchema = z.object({ channelId: z.string().min(1) })
const ProductSlugParamsSchema = z.object({ productSlug: z.string().min(1) })
const WebhookSecretBodySchema = z.object({ secret: z.string().min(16) })

const SIGNATURE_HEADER = 'x-deepsignal-signature'

const syncErrorStatus = (code: string): number => {
  switch (code) {
    case EXTERNAL_AGENT_SYNC_ERROR_CODES.NOT_EXTERNAL_AGENT:
    case EXTERNAL_AGENT_SYNC_ERROR_CODES.UNKNOWN_PRODUCT:
      return 400
    case EXTERNAL_AGENT_SYNC_ERROR_CODES.UPSTREAM_UNAVAILABLE:
      return 502
    case EXTERNAL_AGENT_SYNC_ERROR_CODES.IDENTITY_UNAVAILABLE:
      return 503
    default:
      return 400
  }
}

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

export const registerExternalAgentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    authSecret,
    isJsonContentType,
    deepSignalMcpIdentity,
    getChannelIfMember,
  } = deps

  const secretResolver = createMcpSecretResolver(prisma, authSecret ?? '')

  // ─── History hydration ────────────────────────────────────────────────────
  app.post('/api/channels/:channelId/external-sync', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const params = parseInput(ChannelIdParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    const membership = await getChannelIfMember(
      actorContext.actor.actorId,
      actorContext.tenant.organizationId,
      params.channelId,
    )
    if (!membership) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }
    if (membership.systemChannelType !== 'external_agent') {
      sendApiError(reply, 400, 'NOT_EXTERNAL_AGENT_CHANNEL', 'Channel is not an external-agent channel')
      return reply
    }

    const channel = await prisma.channel.findUnique({
      where: { id: params.channelId },
      select: { id: true, dmKey: true },
    })
    if (!channel) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return reply
    }

    try {
      const result = await syncExternalAgentChannel(
        prisma,
        channel,
        {
          attribution: attributionFromActorContext(actorContext, {
            systemComponent: 'api-deepsignal-history-sync',
          }),
          deepSignalIdentity: deepSignalMcpIdentity,
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
        },
        secretResolver,
      )
      return createApiResponse(result)
    } catch (error) {
      if (error instanceof ExternalAgentSyncError) {
        sendApiError(reply, syncErrorStatus(error.code), error.code, error.message)
        return reply
      }
      throw error
    }
  })

  // ─── Per-org webhook signing secret (admin/owner) ─────────────────────────
  app.put('/api/integrations/products/:productSlug/webhook-secret', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    if (!isAdminActor(actorContext)) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Admin or owner access required')
      return reply
    }

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(WebhookSecretBodySchema, request.body, reply)
    if (!body) return reply

    try {
      await setProductWebhookSecret(prisma, authSecret ?? '', {
        organizationId: actorContext.tenant.organizationId,
        productSlug: params.productSlug,
        secret: body.secret,
      })
    } catch (error) {
      if (error instanceof ProductWebhookSecretError) {
        sendApiError(reply, 400, error.code, error.message)
        return reply
      }
      throw error
    }
    return createApiResponse({ ok: true })
  })

  // ─── Unauthenticated insight webhook receiver ─────────────────────────────
  app.post(
    '/api/integrations/deepsignal/events',
    { config: { public: true } },
    async (request, reply) => {
      if (!isJsonContentType(request)) {
        sendApiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json')
        return reply
      }

      const rawBody = (request as RequestWithRawBody).rawBody
      if (!rawBody) {
        sendApiError(reply, 400, 'INVALID_BODY', 'Missing request body')
        return reply
      }

      const organizationId = await resolveSignedWebhookOrg(prisma, authSecret ?? '', {
        productSlug: DEEPSIGNAL_SLUG,
        rawBody,
        signatureHeader: firstHeader(request.headers[SIGNATURE_HEADER]),
      })
      if (!organizationId) {
        // Missing/invalid signature — reject without revealing whether an org
        // is configured (no per-org information leaks from a single receiver).
        sendApiError(reply, 401, 'INVALID_SIGNATURE', 'Webhook signature verification failed')
        return reply
      }

      const payload = request.body
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        sendApiError(reply, 400, 'INVALID_BODY', 'Expected a JSON object')
        return reply
      }
      const event = (payload as Record<string, unknown>).event
      if (event !== 'insight.surfaced') {
        // Acknowledge unknown events so DeepSignal does not retry a body we do
        // not (yet) act on.
        return createApiResponse({ accepted: false, reason: 'unsupported_event' })
      }

      const body = payload as Record<string, unknown>
      const insightId = resolveInsightId(body)
      if (!insightId) {
        // An `insight.surfaced` with no insight id is malformed, and it is the
        // one field this receiver cannot proceed without: it is the enqueue's
        // idempotency key and the digest's own dedupe token. It used to be
        // answered 200 with `delivered: 0`, which delivered nothing and said so
        // in a field a sender had to know to read. A 4xx never enqueues.
        sendApiError(reply, 400, 'INVALID_BODY', 'insight.surfaced requires an insight id')
        return reply
      }

      // The routing decision stays on the request path; the fan-out does not.
      // An unknown, disabled or mismatched team is DeepSignal's own
      // misconfiguration, and it is the only thing this receiver can tell it
      // about — answering 202 for an event that will reach nobody would hide
      // exactly the case a `delivered: 0` used to expose. One indexed lookup.
      const team = await resolveEnabledExternalTeam(prisma, organizationId, body)
      if (!team) {
        return createApiResponse({ accepted: false, insightId, reason: 'team_not_enabled' })
      }

      // Everything past here — a channel, a thread, a binding and a digest
      // transaction per linked recipient — is the fan-out, and it runs in the
      // worker. Keyed on the insight so a redelivery collapses into the job
      // already queued rather than walking the team a second time
      // (docs/standards/horizontal-scaling.md § 3).
      const enqueued = await enqueueQueueJob(prisma, {
        idempotencyKey: `deepsignal-insight:${organizationId}:${insightId}`,
        payload: {
          insightId,
          organizationId,
          payload: body,
        },
        topic: DEEPSIGNAL_INSIGHT_FANOUT_TOPIC,
      })

      return reply.code(202).send(
        createApiResponse({
          accepted: true,
          existing: !enqueued,
          insightId,
        }),
      )
    },
  )
}
