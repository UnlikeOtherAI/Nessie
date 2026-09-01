import { createHash } from 'node:crypto'

import {
  canStartOAuthForInstance,
  completeOAuth,
  createPgOAuthStateStore,
  getInstance,
  startOAuth,
} from '@nessie/mcp-manage'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { createApiResponse, sendApiError } from '../../lib/api.js'
import { buildOAuthClientResolution } from '../../lib/oauth-client-config.js'
import {
  PublicOriginConfigError,
  resolvePublicOrigin,
  toPublicOrigin,
} from '../../lib/public-origin.js'
import type { AppConfig } from '../../lib/server-context.js'
import { guardAuthRequest, RATE_LIMIT_BUCKETS } from '../auth-rate-limit.js'

import { sendMcpError, type McpSubRegistrarContext } from './shared.js'

/**
 * RFC 6749 §4.1.2.1 — the `error` codes a conforming authorization server may
 * return on the redirect. Anything outside this set is treated as untrusted
 * upstream input (potential reflected XSS / open-redirect bait) and collapsed
 * to `invalid_request` before we send anything back to the browser.
 *
 * It is a literal union rather than a bare `string[]` so the callback page
 * builder below can only ever be handed a member of this fixed set — a value
 * that came from the query string cannot type-check its way onto the page.
 */
const RFC6749_OAUTH_ERROR_CODES = [
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
] as const

export type OAuthCallbackErrorCode = (typeof RFC6749_OAUTH_ERROR_CODES)[number]

const RFC6749_OAUTH_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  RFC6749_OAUTH_ERROR_CODES,
)

const sanitizeOAuthErrorCode = (raw: unknown): OAuthCallbackErrorCode => {
  if (typeof raw !== 'string') return 'invalid_request'
  return RFC6749_OAUTH_ERROR_CODE_SET.has(raw)
    ? (raw as OAuthCallbackErrorCode)
    : 'invalid_request'
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
 * Build the OAuth callback URL the provider should redirect to. The origin
 * comes from `resolvePublicOrigin` (configured `api.publicUrl`, or — local
 * mode only — Fastify's trust-proxy-scoped protocol/hostname); raw
 * X-Forwarded-* / Host headers are never consulted. The path is fixed at
 * `/api/mcp/oauth/callback` per task #20 spec.
 */
export const buildOAuthCallbackUrl = (
  request: FastifyRequest,
  config: Parameters<typeof resolvePublicOrigin>[1],
): string => `${resolvePublicOrigin(request, config)}/api/mcp/oauth/callback`

/** A misconfigured public origin is an operator error, not a client one. */
export const sendPublicOriginError = (reply: Parameters<typeof sendApiError>[0]): void => {
  sendApiError(
    reply,
    500,
    'PUBLIC_ORIGIN_NOT_CONFIGURED',
    'The server cannot determine its public origin; set NESSIE_API_PUBLIC_URL '
      + 'to the public origin of this API (required outside local mode)',
  )
}

/** Local dev admin origin. Ports are fixed by CLAUDE.md: admin is 5455. */
const LOCAL_ADMIN_ORIGIN = 'http://localhost:5455'

/**
 * Scheme + host + optional port and nothing else. `URL.origin` already
 * normalises to that shape, so this is the second lock rather than the first:
 * an operator value that somehow carried markup or a path can never reach the
 * page source, no matter what `URL` decided to accept.
 */
const ADMIN_ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i

/**
 * The one window this page is allowed to talk to.
 *
 * Resolved from operator configuration ONLY — `NESSIE_ADMIN_PUBLIC_URL` /
 * `NESSIE_ADMIN_ORIGIN` (the same pair `routes/comms-connections.ts` already
 * reads), or the fixed local-dev admin origin. Never from the request, never
 * from a query parameter, and never `'*'`: a wildcard target hands the message
 * — and with it the fact that this person just linked a named provider — to
 * whatever page managed to open this one.
 *
 * Unresolvable (a hosted deployment that has not declared its admin origin)
 * returns null and the page ships with no script at all. The opener resolves
 * the flow by polling connection status on focus either way, so degrading is
 * honest; guessing an origin would not be.
 */
export const resolveAdminOrigin = (
  config: Pick<AppConfig, 'mode'>,
): string | null => {
  const configured =
    process.env.NESSIE_ADMIN_PUBLIC_URL
    ?? process.env.NESSIE_ADMIN_ORIGIN
    ?? (config.mode === 'local' ? LOCAL_ADMIN_ORIGIN : undefined)
  if (!configured) return null
  const origin = toPublicOrigin(configured)
  return origin && ADMIN_ORIGIN_PATTERN.test(origin) ? origin : null
}

const CALLBACK_PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; color: #333; background: #faf9f7; }
  .card { text-align: center; padding: 2rem 3rem; border: 1px solid #e5e1da; border-radius: 12px; background: #fff; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #666; }
`

/** CSP source expression pinning one inline `<script>`/`<style>` by content. */
const cspHash = (source: string): string =>
  `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`

/**
 * The script that tells the opener the flow finished. Both the payload and
 * the target origin are server-authored constants: the payload shape is fixed
 * here, `ok`/`error` come from the RFC 6749 enumeration above, and the target
 * comes from `resolveAdminOrigin`. Nothing on this page is request-derived,
 * which is the property `api/test/mcp-oauth-callback.test.ts` pins.
 */
const buildCallbackScript = (
  payload: { source: 'nessie'; kind: 'mcp-oauth'; ok: boolean; error?: string },
  adminOrigin: string,
): string => `
(function () {
  var message = ${JSON.stringify(payload)};
  var target = ${JSON.stringify(adminOrigin)};
  try {
    if (window.opener) window.opener.postMessage(message, target);
  } catch (e) {}
  window.setTimeout(function () { try { window.close(); } catch (e) {} }, 400);
})();
`

type CallbackOutcome =
  | { ok: true }
  | { ok: false; error: OAuthCallbackErrorCode }

/**
 * Build the page the provider's redirect lands in. Deliberately still a
 * constant page — no redirect back to the SPA, because a caller-supplied
 * return URL is an open-redirect surface this flow does not need.
 *
 * The returned CSP pins the page's only script and style by SHA-256, so even
 * a future regression that interpolated request data could not get it to
 * execute.
 */
export const buildOAuthCallbackPage = (
  outcome: CallbackOutcome,
  adminOrigin: string | null,
): { html: string; csp: string } => {
  const script = adminOrigin
    ? buildCallbackScript(
      outcome.ok
        ? { source: 'nessie', kind: 'mcp-oauth', ok: true }
        : { source: 'nessie', kind: 'mcp-oauth', ok: false, error: outcome.error },
      adminOrigin,
    )
    : null
  const heading = outcome.ok ? 'Connected ✓' : 'Sign-in didn’t finish'
  const body = outcome.ok
    ? 'Your account is linked. You can close this tab and return to Nessie.'
    : 'Nothing was connected. You can close this tab and try again in Nessie.'
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${outcome.ok ? 'Connected' : 'Sign-in didn’t finish'}</title>
<style>${CALLBACK_PAGE_STYLE}</style></head>
<body><div class="card">
  <h1>${heading}</h1>
  <p>${body}</p>
</div>${script ? `<script>${script}</script>` : ''}</body>
</html>`
  const csp = [
    "default-src 'none'",
    `script-src ${script ? cspHash(script) : "'none'"}`,
    `style-src ${cspHash(CALLBACK_PAGE_STYLE)}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  return { html, csp }
}

/**
 * A browser following the provider's redirect asks for HTML; every other
 * caller — the pinned JSON error contract, curl, a probe — keeps the JSON
 * body. The negotiation picks between two server-authored responses; no
 * request data reaches either of them.
 */
const wantsHtml = (request: FastifyRequest): boolean =>
  (request.headers.accept ?? '').includes('text/html')

export const registerMcpOAuthRoutes = (
  app: FastifyInstance,
  ctx: McpSubRegistrarContext,
): void => {
  const { prisma, requireActorContext, oauthSecretStore, config, rateLimiter } = ctx
  const stateStore = ctx.oauthStateStore ?? createPgOAuthStateStore(prisma)
  /**
   * Which client identity this deployment may present. Built once, here, from
   * operator configuration alone: `resolveOAuthClientStrategy` can only reach
   * its CIMD and operator tiers if a caller supplies these facts, and a
   * malformed operator client list must fail the boot rather than one
   * authorize request.
   */
  const clientResolution = buildOAuthClientResolution({
    apiPublicUrl: config.api.publicUrl,
    env: process.env,
  })

  app.post('/api/mcp/instances/:instanceId/oauth/start', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    // Brute-force guard on state minting: caps state-token sprays per IP.
    if (
      !(await guardAuthRequest(
        rateLimiter,
        {
          bucket: RATE_LIMIT_BUCKETS.mcpOauthIp,
          rule: config.api.rateLimit.mcpOauthIp,
        },
        request,
        reply,
        { auditContext: actorContext },
      ))
    ) {
      return reply
    }

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

    // Resolve the public origin OUTSIDE the OAuth service call: a missing
    // config must fail before any state token is minted or upstream metadata
    // is discovered (dynamic client registration would persist a steered
    // origin), never be swallowed into a provider flow.
    let callbackUrl: string
    try {
      callbackUrl = buildOAuthCallbackUrl(request, config)
    } catch (error) {
      if (error instanceof PublicOriginConfigError) {
        sendPublicOriginError(reply)
        return reply
      }
      throw error
    }
    try {
      const result = await startOAuth({
        prisma,
        store: stateStore,
        secretStore: oauthSecretStore,
        instanceId,
        actorContext,
        callbackUrl,
        resolveHost: ctx.oauthResolveHost,
        clientResolution,
      })
      return createApiResponse(result)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/mcp/oauth/callback', { config: { public: true } }, async (request, reply) => {
    // Callback is open by design — the provider redirects the end-user's
    // browser here with `code` + `state`. Authn lives in the state token
    // itself (random, single-use, server-side stored). We do NOT require an
    // actor context because the user's session may have rotated between
    // `start` and the provider's redirect; the state record carries the
    // original actor id.
    // Brute-force guard on the unauthenticated callback: caps state-guessing
    // sprays per IP before any upstream code exchange is attempted.
    if (
      !(await guardAuthRequest(
        rateLimiter,
        {
          bucket: RATE_LIMIT_BUCKETS.mcpOauthIp,
          rule: config.api.rateLimit.mcpOauthIp,
        },
        request,
        reply,
      ))
    ) {
      return reply
    }
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
      // A browser lands here when the person declines the consent screen, so
      // it gets the same constant page as success — carrying `ok: false` and
      // the sanitized code, which is what lets the opener show "Connection
      // cancelled" immediately instead of waiting out its poll timeout.
      if (wantsHtml(request)) {
        const page = buildOAuthCallbackPage(
          { ok: false, error: sanitized },
          resolveAdminOrigin(config),
        )
        return reply
          .code(400)
          .header('content-security-policy', page.csp)
          .type('text/html')
          .send(page.html)
      }
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
    let callbackUrl: string
    try {
      callbackUrl = buildOAuthCallbackUrl(request, config)
    } catch (error) {
      if (error instanceof PublicOriginConfigError) {
        sendPublicOriginError(reply)
        return reply
      }
      throw error
    }
    try {
      await completeOAuth({
        prisma,
        store: stateStore,
        secretStore: oauthSecretStore,
        secretResolver: ctx.secretResolver,
        state: query.state,
        code: query.code,
        callbackUrl,
      })
      // The redirect lands in a bare browser tab — answer with a human page,
      // not JSON.
      const page = buildOAuthCallbackPage({ ok: true }, resolveAdminOrigin(config))
      return reply
        .header('content-security-policy', page.csp)
        .type('text/html')
        .send(page.html)
    } catch (error) {
      if (sendMcpError(reply, error)) return reply
      throw error
    }
  })
}
