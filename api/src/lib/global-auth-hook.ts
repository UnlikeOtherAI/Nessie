import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'

import {
  isVoiceCredentialToken,
  touchVoiceDeviceCredential,
  verifyVoiceDeviceCredential,
} from '../services/voice/voice-device-credential.js'
import {
  isAgentCredentialToken,
  touchAgentAccessCredential,
  verifyAgentAccessCredential,
} from '../services/mcp-agent/agent-credential.js'
import { createGlobalRateLimitCheck } from '../routes/auth-rate-limit.js'
import { sendApiError } from './api.js'
import { resolvePublicOrigin } from './public-origin.js'
import type { ServerContext } from './server-context.js'

type GlobalAuthHookDeps = Pick<
  ServerContext,
  'authenticateRequest' | 'config' | 'rateLimiter'
> & { prisma: PrismaClient }

/**
 * Reads the bearer without verifying it.
 *
 * Only used to choose which verifier runs. The token is a credential either
 * way and neither path trusts it before checking it.
 */
const bearerToken = (header: string | undefined): string | null => {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

/**
 * Where a client can learn how to authenticate to the MCP endpoint.
 *
 * Returns null on a deployment with no public origin configured: a challenge
 * pointing nowhere is worse than none, because a client would follow it.
 */
const agentResourceMetadataUrl = (
  request: Parameters<typeof resolvePublicOrigin>[0],
  config: Parameters<typeof resolvePublicOrigin>[1],
): string | null => {
  try {
    return `${resolvePublicOrigin(request, config)}/.well-known/oauth-protected-resource`
  } catch {
    return null
  }
}

/**
 * Apply the API-wide rate-limit and authentication gate.
 *
 * Routes opt out of authentication only with Fastify's explicit
 * `config.public` metadata. This keeps every other route fail-closed by
 * default while allowing provider callbacks that authenticate through a
 * separate, route-specific mechanism.
 */
export const registerGlobalAuthHook = (
  app: FastifyInstance,
  { authenticateRequest, config, prisma, rateLimiter }: GlobalAuthHookDeps,
): void => {
  // The API-wide per-IP check, built here from the shared limiter and the
  // thresholds in config. It is bound at registration rather than handed in
  // pre-built so there is exactly one place that decides which bucket governs
  // a request (2026-09-05 review, FO3-3).
  const checkRateLimit = createGlobalRateLimitCheck({ config, rateLimiter })

  // Rate limiting runs at `onRequest`, before the JSON body parser buffers and
  // parses the payload (and before multipart accepts up to
  // `storage.maxUploadBytes`). The cheapest rejection a server can make must
  // not be its most expensive one (2026-09-05 review, FO3-6). Actor
  // resolution stays at `preHandler`, where the request is otherwise ready.
  app.addHook('onRequest', async (request, reply) => {
    if (!(await checkRateLimit(request, reply))) {
      return reply
    }
    return undefined
  })

  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.public === true) {
      return
    }

    // RFC 9728 §5.1, set before verification so EVERY refusal on an
    // agent-credential route carries it — a missing bearer, an expired one, a
    // revoked one. Setting it inside the route handler would have been
    // pointless: an unauthenticated request is rejected here and never reaches
    // one, which is exactly how it ends up an opaque 401 with nothing for a
    // client to act on.
    if (request.routeOptions.config.agentCredential === true) {
      const metadataUrl = agentResourceMetadataUrl(request, config)
      if (metadataUrl) {
        reply.header('www-authenticate', `Bearer resource_metadata="${metadataUrl}"`)
      }
    }

    // The voice-scoped device credential, accepted only where a route opts in.
    //
    // A phone on a locked screen cannot reach the WebView session, so the
    // native layer holds this instead. It is recognised by its own prefix
    // rather than by trying the JWT verifier first and falling through: a
    // credential that fails here must produce a voice-specific 401 the native
    // client can act on (re-provision, or stop) rather than a generic one.
    const presented = bearerToken(request.headers.authorization)
    if (presented && isVoiceCredentialToken(presented)) {
      if (request.routeOptions.config.voiceCredential !== true) {
        // The scope, enforced. Presenting it anywhere else is not a partial
        // success to be retried — it is a route this credential cannot reach.
        sendApiError(
          reply,
          403,
          'VOICE_CREDENTIAL_OUT_OF_SCOPE',
          'This credential is only accepted on voice call routes.',
        )
        return
      }
      const verified = await verifyVoiceDeviceCredential(prisma, presented)
      if (!verified.ok) {
        sendApiError(reply, 401, verified.code, verified.message)
        return
      }
      request.actorContext = verified.actorContext
      request.voiceCredential = verified.credential
      // Best-effort: an operator looking at a device list wants to see which
      // one is on a call, and a failed bookkeeping write must not fail a call.
      void touchVoiceDeviceCredential(prisma, verified.credential.id)
      return
    }

    // The agent access credential, on the same terms as the voice one: its own
    // prefix, its own verifier, and refused outside the routes that opt in.
    // Presenting it on an ordinary API route is not a partial success to be
    // retried — it is a route this credential cannot reach, and saying so is
    // what keeps "I lent an agent my boards" from meaning "I lent it my
    // account".
    if (presented && isAgentCredentialToken(presented)) {
      if (request.routeOptions.config.agentCredential !== true) {
        sendApiError(
          reply,
          403,
          'AGENT_CREDENTIAL_OUT_OF_SCOPE',
          'This credential is only accepted on the MCP endpoint.',
        )
        return
      }
      const verified = await verifyAgentAccessCredential(prisma, presented)
      if (!verified.ok) {
        sendApiError(reply, 401, verified.code, verified.message)
        return
      }
      request.actorContext = verified.actorContext
      request.agentCredential = verified.credential
      // Best-effort: an operator looking at the credential list wants to know
      // which agents are actually live, and a failed bookkeeping write must
      // not fail the call it was recording.
      void touchAgentAccessCredential(prisma, verified.credential.id)
      return
    }

    await authenticateRequest(request, reply)
  })
}
