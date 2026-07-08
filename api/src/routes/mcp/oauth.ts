import {
  canStartOAuthForInstance,
  completeOAuth,
  createPgOAuthStateStore,
  getInstance,
  startOAuth,
} from '@nessie/mcp-manage'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { createApiResponse, sendApiError } from '../../lib/api.js'

import { sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * RFC 6749 §4.1.2.1 — the set of `error` codes a conforming authorization
 * server may return on the redirect. Anything outside this set is treated as
 * untrusted upstream input (potential reflected XSS / open-redirect bait) and
 * collapsed to `invalid_request` before we send anything back to the browser.
 */
const RFC6749_OAUTH_ERROR_CODES = new Set([
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
])

const sanitizeOAuthErrorCode = (raw: unknown): string => {
  if (typeof raw !== 'string') return 'invalid_request'
  return RFC6749_OAUTH_ERROR_CODES.has(raw) ? raw : 'invalid_request'
}

/**
 * OAuth handshake sub-registrar.
 *
 * `start` mints a cryptographically random state token (10-min TTL,
 * single-use, Postgres-backed so worker-minted flows complete here too) and
 * returns the authorization URL. Static catalog configs use the
 * pre-registered client; dynamic configs discover the server's OAuth metadata
 * and register a client on the fly (PKCE, RFC 8707 `resource`).
 *
 * `start` is open to any signed-in user who can reach the instance: the
 * minted token only ever lands on the caller's own identity (their user-scope
 * instance or their per-user credential override), so connecting "my Notion"
 * is self-service by construction.
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

/**
 * Static success page for the browser tab the provider redirects into. No
 * request data is interpolated — the page is a constant string, so there is
 * no reflected-XSS surface.
 */
const CALLBACK_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Connected</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; color: #333; background: #faf9f7; }
  .card { text-align: center; padding: 2rem 3rem; border: 1px solid #e5e1da; border-radius: 12px; background: #fff; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #666; }
</style></head>
<body><div class="card">
  <h1>Connected ✓</h1>
  <p>Your account is linked. You can close this tab and return to Nessie.</p>
</div></body>
</html>`

export const registerMcpOAuthRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, oauthSecretStore } = ctx
  const stateStore = ctx.oauthStateStore ?? createPgOAuthStateStore(prisma)

  app.post('/api/mcp/instances/:instanceId/oauth/start', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { instanceId } = request.params as { instanceId: string }
    const instance = await getInstance(
      prisma,
      actorContext.tenant.organizationId,
      instanceId,
    )
    if (!instance) {
      sendApiError(reply, 404, 'MCP_OAUTH_INSTANCE_NOT_FOUND', 'Instance not found')
      return reply
    }
    const allowed = await canStartOAuthForInstance(
      prisma,
      actorContext.tenant.organizationId,
      actorContext.actor.actorId,
      instance,
    )
    if (!allowed) {
      sendApiError(
        reply,
        403,
        'MCP_INSTANCE_FORBIDDEN',
        'You do not have access to this connector',
      )
      return reply
    }

    try {
      const result = await startOAuth({
        prisma,
        store: stateStore,
        secretStore: oauthSecretStore,
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
    const query = request.query as {
      code?: string
      state?: string
      error?: string
      error_description?: string
    }
    if (query.error !== undefined) {
      // Never echo `query.error` or `query.error_description` back to the
      // client — both are attacker-controllable via the upstream provider URL.
      // Collapse to the RFC 6749 §4.1.2.1 enumeration; log the raw values
      // server-side for diagnosis.
      const sanitized = sanitizeOAuthErrorCode(query.error)
      app.log.warn(
        {
          rawError: query.error,
          rawErrorDescription: query.error_description,
          sanitizedError: sanitized,
        },
        'OAuth provider returned error on callback',
      )
      sendApiError(
        reply,
        400,
        'MCP_OAUTH_PROVIDER_ERROR',
        `OAuth provider returned error: ${sanitized}`,
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
      await completeOAuth({
        prisma,
        store: stateStore,
        secretStore: oauthSecretStore,
        secretResolver: ctx.secretResolver,
        state: query.state,
        code: query.code,
        callbackUrl: buildOAuthCallbackUrl(request),
      })
      // The redirect lands in a bare browser tab — answer with a human page,
      // not JSON.
      return reply.type('text/html').send(CALLBACK_SUCCESS_HTML)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })
}
