import type { FastifyReply, FastifyRequest } from 'fastify'
import type { NessieConfig } from '@nessie/config'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { sendApiError } from '../lib/api.js'
import type { RateLimiter, RateLimitRule } from '../services/rate-limit.js'

/**
 * Store-key buckets for the rate limiter (issue #211). The bucket lives in the
 * store key (`sha256(bucket:identity)`), the audit resourceId, and the
 * ops-health breakdown — never in the rule, which is only `{max, windowMs}`
 * thresholds loaded from config.
 *
 * Every name here MUST also exist under `config.api.rateLimit`: `rateLimitFor`
 * indexes the config object by this union, so adding a bucket without its rule
 * (or renaming one on either side) is a compile error rather than a call site
 * quietly borrowing an unrelated rule the way `ssoAuthorizeIp` borrowed
 * `mcpOauthIp` (2026-09-05 review, FO3-7).
 */
export const RATE_LIMIT_BUCKETS = {
  loginIp: 'auth.login.ip',
  loginAccount: 'auth.login.account',
  refreshIp: 'auth.refresh.ip',
  refreshAccount: 'auth.refresh.account',
  bootstrapIp: 'auth.bootstrap.ip',
  ssoAuthorizeIp: 'auth.sso_authorize.ip',
  mcpOauthIp: 'mcp.oauth.ip',
  mcpSecretWriteIp: 'mcp.secret_write.ip',
  mcpSecretWriteAccount: 'mcp.secret_write.account',
  executorDaemonIp: 'executor.daemon.ip',
  stepUpIp: 'auth.step_up.ip',
  stepUpAccount: 'auth.step_up.account',
  // Personal model subscriptions. `start` mints a device code at a shared
  // public client, and `poll` reaches the provider on Nessie's server IP —
  // unbounded, one member could get that client throttled for everyone.
  subscriptionDeviceIp: 'model_subscription.device.ip',
  subscriptionDeviceAccount: 'model_subscription.device.account',
  // Applied by the global hook (`resolveGlobalRateLimitBucket`), not by a
  // handler. The first four carry the thresholds of the in-process limiter
  // this replaced (FO3-3/FO4-1); the rest close the public-route coverage gap
  // (FO3-7/F5-5).
  threadMessageIp: 'api.thread_message.ip',
  mailboxDiscoverIp: 'api.mailbox_discover.ip',
  agentWriteIp: 'api.agent_write.ip',
  authMeIp: 'auth.me.ip',
  triggerWebhookIp: 'trigger.webhook.ip',
  commsWebhookIp: 'comms.webhook.ip',
  boardSourceWebhookIp: 'board_source.webhook.ip',
  agentEmailInboundIp: 'agent_email.inbound.ip',
  executorDaemonSessionIp: 'executor.daemon_session.ip',
  publicRouteIp: 'api.public.ip',
} as const

export type RateLimitBucketName = keyof typeof RATE_LIMIT_BUCKETS

/**
 * The one bucket→rule pairing. Every guard resolves its `{bucket, rule}` pair
 * through here instead of naming a bucket beside a hand-picked
 * `config.api.rateLimit.<something>`, so the two halves cannot drift apart.
 */
export const rateLimitFor = (
  config: NessieConfig,
  name: RateLimitBucketName,
): { bucket: string; rule: RateLimitRule } =>
  rateLimitForRules(config.api.rateLimit, name)

/**
 * The same pairing for a guard that is handed `config.api.rateLimit` rather
 * than the whole config (`requireFreshExecutorPasswordVerification`). It is
 * where `rateLimitFor` resolves to, so there is still one table lookup and one
 * compile-checked union — not a second, parallel pairing.
 */
export const rateLimitForRules = (
  rules: NessieConfig['api']['rateLimit'],
  name: RateLimitBucketName,
): { bucket: string; rule: RateLimitRule } => ({
  bucket: RATE_LIMIT_BUCKETS[name],
  rule: rules[name],
})

/**
 * Shared brute-force guard for the auth route family (issue #211). Sends the
 * 429 + Retry-After response and returns false when a limit trips; the client
 * IP is Fastify's resolved `request.ip`, which only honours
 * `X-Forwarded-For` when `NESSIE_API_TRUSTED_PROXY_HOPS` allows it
 * (api/src/index.ts trustProxy wiring) — forwarded headers are never trusted
 * otherwise.
 */
export const guardAuthRequest = async (
  rateLimiter: RateLimiter,
  ip: { bucket: string; rule: RateLimitRule },
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    account?: { bucket: string; rule: RateLimitRule }
    accountIdentity?: string | null
    auditContext?: AuthorizedActionContext | null
    session?: { userId: string; organizationId: string } | null
  } = {},
): Promise<boolean> => {
  const result = await rateLimiter.guard({
    rules: {
      ip,
      ...(options.account ? { account: options.account } : {}),
    },
    ip: request.ip,
    accountIdentity: options.accountIdentity ?? null,
    auditContext: options.auditContext ?? null,
    session: options.session ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  })
  if (result.allowed) {
    return true
  }
  reply.header('retry-after', String(result.retryAfterSeconds))
  sendApiError(reply, 429, 'RATE_LIMITED', 'Too many requests')
  return false
}

/** Per-owner guard for MCP secret writes: IP + actor account counters. */
export const guardMcpSecretWrite = async (
  rateLimiter: RateLimiter,
  rules: { mcpSecretWriteIp: RateLimitRule; mcpSecretWriteAccount: RateLimitRule },
  request: FastifyRequest,
  reply: FastifyReply,
  actorContext: Parameters<RateLimiter['guard']>[0]['auditContext'],
): Promise<boolean> => {
  const result = await rateLimiter.guard({
    rules: {
      ip: { bucket: RATE_LIMIT_BUCKETS.mcpSecretWriteIp, rule: rules.mcpSecretWriteIp },
      account: {
        bucket: RATE_LIMIT_BUCKETS.mcpSecretWriteAccount,
        rule: rules.mcpSecretWriteAccount,
      },
    },
    ip: request.ip,
    accountIdentity: actorContext?.actor.actorId ?? null,
    auditContext: actorContext ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  })
  if (result.allowed) {
    return true
  }
  reply.header('retry-after', String(result.retryAfterSeconds))
  sendApiError(reply, 429, 'RATE_LIMITED', 'Too many requests')
  return false
}

/**
 * The route table the global hook applies, keyed by Fastify's route pattern.
 *
 * Rate limiting used to be two mechanisms: a hard-coded in-process `Map` in
 * `lib/rate-limit.ts` that the global hook applied to four routes, and this
 * Postgres-backed limiter that each auth handler opted into. They disagreed on
 * the store (per-replica vs shared), on IP canonicalisation (raw `request.ip`
 * vs IPv6 collapsed to its /64), and on where the thresholds lived — and both
 * governed `POST /api/auth/session` (2026-09-05 review, FO3-3/FO4-1). This is
 * the surviving table; the entries below are the four the in-process limiter
 * carried plus the public intakes that had nothing at all (FO3-7/F5-5).
 *
 * Routes that guard themselves in their handler (login, refresh, bootstrap,
 * SSO authorize, MCP OAuth, subscription device codes) are deliberately
 * absent: they stay on their own tighter bucket and, being public,
 * additionally count against `publicRouteIp`. The floor is additional, never a
 * replacement.
 */
const AGENT_WRITE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT'])

const EXECUTOR_DAEMON_SESSION_ROUTES = new Set([
  '/api/executor-daemon/claim',
  '/api/executor-daemon/heartbeat',
  '/api/executor-daemon/descriptor',
  '/api/executor-daemon/commands/poll',
  '/api/executor-daemon/commands/receipt',
  '/api/executor-enrollments/submit',
])

const POST_ROUTE_BUCKETS: ReadonlyMap<string, RateLimitBucketName> = new Map([
  // The daemon pairing challenge. It used to guard itself in its handler, the
  // one of the seven daemon routes that did, so the pairing surface was split
  // between this table and a hand-written call (2026-09-05 review, FO3-3).
  ['/api/executor-daemon/challenge', 'executorDaemonIp'],
  ['/api/threads/:threadId/messages', 'threadMessageIp'],
  ['/api/mailbox-connections/discover', 'mailboxDiscoverIp'],
  ['/api/triggers/webhook', 'triggerWebhookIp'],
  ['/api/triggers/:triggerId/webhook', 'triggerWebhookIp'],
  ['/api/comms/webhooks/slack', 'commsWebhookIp'],
  ['/api/comms/webhooks/google', 'commsWebhookIp'],
  ['/api/board-sources/webhooks/:provider', 'boardSourceWebhookIp'],
  ['/api/board-sources/webhooks/:provider/:token', 'boardSourceWebhookIp'],
  ['/api/integrations/email/inbound', 'agentEmailInboundIp'],
])

/**
 * Which bucket governs this request, or null when nothing does.
 *
 * `isPublic` is the route's own `config.public` flag: every public route gets
 * the `publicRouteIp` floor unless the table names something tighter, so
 * coverage is a property of being public rather than of somebody remembering.
 */
export const resolveGlobalRateLimitBucket = (input: {
  isPublic: boolean
  method: string
  routePath: string
}): RateLimitBucketName | null => {
  const method = input.method.toUpperCase()
  if (method === 'GET' && input.routePath === '/api/auth/me') return 'authMeIp'
  if (method === 'POST') {
    const named = POST_ROUTE_BUCKETS.get(input.routePath)
    if (named) return named
    if (EXECUTOR_DAEMON_SESSION_ROUTES.has(input.routePath)) {
      return 'executorDaemonSessionIp'
    }
  }
  if (input.routePath.startsWith('/api/agents') && AGENT_WRITE_METHODS.has(method)) {
    return 'agentWriteIp'
  }
  return input.isPublic ? 'publicRouteIp' : null
}

/**
 * The API-wide per-IP check the global hook runs, built once from the shared
 * limiter and config. Sends the 429 + `Retry-After` itself and returns false
 * when a limit trips, matching `guardAuthRequest`.
 */
export const createGlobalRateLimitCheck = (deps: {
  config: NessieConfig
  rateLimiter: RateLimiter
}) => async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  // `routeOptions` is populated by the router before `onRequest` runs, but a
  // request that matched no route reaches the 404 handler with no `url`; fall
  // back to the request path so such a request is still classified rather
  // than throwing.
  const routePath = request.routeOptions?.url
    ?? new URL(request.url, 'http://localhost').pathname
  const bucket = resolveGlobalRateLimitBucket({
    isPublic: request.routeOptions?.config?.public === true,
    method: request.method,
    routePath,
  })
  if (!bucket) return true
  return guardAuthRequest(
    deps.rateLimiter,
    rateLimitFor(deps.config, bucket),
    request,
    reply,
  )
}
