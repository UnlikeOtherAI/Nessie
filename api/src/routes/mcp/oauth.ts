import type { FastifyInstance, FastifyRequest } from 'fastify'

import { createApiResponse, sendApiError } from '../../lib/api.js'
import { completeOAuth, startOAuth } from '../../services/mcp-oauth.js'

import { sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * OAuth handshake sub-registrar (plan §6).
 *
 * `start` mints a cryptographically random state token (10-min TTL,
 * single-use) and returns the authorization URL the admin UI should send the
 * user to. The callback verifies state, exchanges the auth code for tokens
 * via the catalog entry's `tokenUrl`, persists the access token through the
 * injected `SecretStore`, and links the resulting `secret_*` ref onto a
 * per-user `McpServerCredentialOverride` row so multiple users installing
 * the same instance keep separate OAuth identities.
 */

/**
 * Build the OAuth callback URL the provider should redirect to. We resolve
 * the protocol/host from the inbound request rather than hardcoding so the
 * same code works behind a reverse proxy or on localhost dev. The path is
 * fixed at `/api/mcp/oauth/callback` per task #20 spec.
 */
const buildOAuthCallbackUrl = (request: FastifyRequest): string => {
  const protoHeader = request.headers['x-forwarded-proto']
  const proto = typeof protoHeader === 'string'
    ? protoHeader.split(',')[0]?.trim() ?? request.protocol
    : request.protocol
  const hostHeader = request.headers['x-forwarded-host'] ?? request.headers.host
  const host = typeof hostHeader === 'string' ? hostHeader.split(',')[0]?.trim() : undefined
  if (!host) {
    // Fallback to a relative-ish URL so we still surface a usable redirect
    // even when the host header is missing — most providers will reject this
    // but at least the error is visible in logs rather than silently using
    // the wrong domain.
    return '/api/mcp/oauth/callback'
  }
  return `${proto}://${host}/api/mcp/oauth/callback`
}

export const registerMcpOAuthRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, requireOwner, oauthSecretStore } = ctx

  app.post('/api/mcp/instances/:instanceId/oauth/start', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { instanceId } = request.params as { instanceId: string }
    try {
      const result = await startOAuth({
        prisma,
        instanceId,
        actorContext,
        callbackUrl: buildOAuthCallbackUrl(request),
      })
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/oauth/callback', async (request, reply) => {
    // Callback is open by design — the provider redirects the end-user's
    // browser here with `code` + `state`. Authn lives in the state token
    // itself (random, single-use, server-side stored). We do NOT require an
    // actor context because the user's session may have rotated between
    // `start` and the provider's redirect; the state record carries the
    // original actor id.
    const query = request.query as { code?: string; state?: string; error?: string }
    if (query.error) {
      sendApiError(
        reply,
        400,
        'MCP_OAUTH_PROVIDER_ERROR',
        `OAuth provider returned error: ${query.error}`,
      )
      return reply
    }
    if (!query.code || !query.state) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        'OAuth callback requires both `code` and `state`',
      )
      return reply
    }
    try {
      const result = await completeOAuth({
        prisma,
        secretStore: oauthSecretStore,
        state: query.state,
        code: query.code,
        callbackUrl: buildOAuthCallbackUrl(request),
      })
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })
}
