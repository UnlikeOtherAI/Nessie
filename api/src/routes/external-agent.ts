import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import { parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RequestWithRawBody } from '../lib/server-context.js'
import {
  ExternalAgentSyncError,
  EXTERNAL_AGENT_SYNC_ERROR_CODES,
  syncExternalAgentChannel,
} from '../services/external-agent-sync.js'
import {
  resolveSignedWebhookOrg,
  setProductWebhookSecret,
} from '../services/product-webhook-secret.js'
import {
  DEEPSIGNAL_SLUG,
  handleDeepSignalInsightSurfaced,
} from '../services/deepsignal-webhook.js'
import type { SignalDigestOptions } from '../services/deepsignal-digest.js'
import type { RouteDeps } from './types.js'

/**
 * External-agent history hydration + proactive-insight delivery (DeepSignal
 * integration plan §6). Three surfaces:
 *   - `POST /api/channels/:channelId/external-sync` — pull DeepSignal history
 *     into the channel (member-gated).
 *   - `PUT  /api/integrations/products/:productSlug/webhook-secret` — org admin
 *     sets the per-org inbound-webhook signing secret.
 *   - `POST /api/integrations/deepsignal/events` — unauthenticated, HMAC-verified
 *     receiver for `insight.surfaced`.
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
    default:
      return 400
  }
}

const isAdminOrOwner = (roles: string[] | undefined): boolean =>
  Boolean(roles?.some((role) => role === 'owner' || role === 'admin'))

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

/** Positive-number env override, else undefined (service default applies). */
const envPositive = (name: string): number | undefined => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Delivery-shaping options for the proactive digest, from env. Absent vars leave
 * the service's heuristic defaults (coalesce ~1h, budget ~6 fresh digests / 24h)
 * in force — deliberate, overridable defaults, not hard rules.
 */
const digestOptionsFromEnv = (): SignalDigestOptions => ({
  coalesceWindowMs: envPositive('NESSIE_SIGNAL_DIGEST_WINDOW_MS'),
  budgetWindowMs: envPositive('NESSIE_SIGNAL_BUDGET_WINDOW_MS'),
  budgetMax: envPositive('NESSIE_SIGNAL_BUDGET_MAX'),
})

export const registerExternalAgentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    authSecret,
    isJsonContentType,
    realtimeHub,
    buildChannelRealtimeScopes,
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
        { organizationId: actorContext.tenant.organizationId, userId: actorContext.actor.actorId },
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
    if (!isAdminOrOwner(actorContext.actor.roles)) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Admin or owner access required')
      return reply
    }

    const params = parseInput(ProductSlugParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(WebhookSecretBodySchema, request.body, reply)
    if (!body) return reply

    await setProductWebhookSecret(prisma, authSecret ?? '', {
      organizationId: actorContext.tenant.organizationId,
      productSlug: params.productSlug,
      secret: body.secret,
    })
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
        return createApiResponse({ accepted: false })
      }

      const result = await handleDeepSignalInsightSurfaced(
        prisma,
        organizationId,
        payload as Record<string, unknown>,
        digestOptionsFromEnv(),
      )

      await publishInsightDeliveries(realtimeHub, buildChannelRealtimeScopes, organizationId, result)

      return createApiResponse({
        accepted: true,
        insightId: result.insightId,
        delivered: result.deliveries.length,
      })
    },
  )
}

/**
 * Best-effort live notification, only for a *freshly posted* digest message.
 * Coalesced/suppressed insights update an existing message in place, so they must
 * not re-emit `message.new` — that is the whole point of batching over interrupts.
 */
const publishInsightDeliveries = async (
  realtimeHub: RouteDeps['realtimeHub'],
  buildChannelRealtimeScopes: RouteDeps['buildChannelRealtimeScopes'],
  organizationId: string,
  result: Awaited<ReturnType<typeof handleDeepSignalInsightSurfaced>>,
): Promise<void> => {
  for (const delivery of result.deliveries) {
    if (delivery.mode !== 'posted') continue
    try {
      await realtimeHub.publishWs(
        buildChannelRealtimeScopes({
          channelId: delivery.channelId,
          organizationId,
          systemChannelType: 'external_agent',
        }),
        {
          data: {
            agentId: delivery.agentId ? parseAgentId(delivery.agentId) : undefined,
            authorUserId: undefined,
            channelId: parseChannelId(delivery.channelId),
            contentPreview: 'New signals from DeepSignal',
            messageId: delivery.messageId,
            role: 'assistant',
            threadId: parseThreadId(delivery.threadId),
          },
          event: 'message.new',
        },
      )
    } catch {
      // A realtime publish failure must never fail the webhook — the message row
      // is already persisted and will load on the next fetch/hydration.
    }
  }
}
