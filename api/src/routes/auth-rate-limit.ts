import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { sendApiError } from '../lib/api.js'
import type { RateLimiter, RateLimitRule } from '../services/rate-limit.js'

/**
 * Store-key buckets for the auth route family (issue #211). The bucket lives
 * in the store key (`sha256(bucket:identity)`), the audit resourceId, and the
 * ops-health breakdown — never in the rule, which is only `{max, windowMs}`
 * thresholds loaded from config.
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
  voiceTranscriptionIp: 'voice.transcription.ip',
  voiceTranscriptionAccount: 'voice.transcription.account',
} as const

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
