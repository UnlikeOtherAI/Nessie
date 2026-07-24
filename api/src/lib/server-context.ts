import { randomUUID, timingSafeEqual } from 'node:crypto'

import type { FastifyCorsOptions } from '@fastify/cors'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { loadConfig } from '@nessie/config'
import {
  type AuthorizedActionContext,
  type MeResponse,
} from '@nessie/schemas'
import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'
import {
  createBootstrapTokenState,
  isBootstrapTokenExpired,
  type BootstrapTokenState,
} from '../auth/bootstrap.js'
import { verifySessionToken, type SessionTokenClaims } from '../auth/session.js'
import { sendApiError } from './api.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
} from '../services/auth.js'
import { createSessionIssuers } from '../services/session-issuers.js'
import { createRequestRateLimitChecker } from './rate-limit.js'
import { createRequestHelpers } from './request-helpers.js'
import { createRateLimiter } from '../services/rate-limit.js'

export {
  createFastifyTrustProxyConfig,
  getRateLimitClientId,
} from './rate-limit.js'

export type AppConfig = ReturnType<typeof loadConfig>

export type AuthenticatedRequestState = {
  actorContext: AuthorizedActionContext
  claims: SessionTokenClaims
  me: MeResponse
}

export type RequestWithRawBody = FastifyRequest & {
  rawBody?: Buffer
}

const DEFAULT_LOCAL_PROVIDER_TYPE = 'local-bootstrap'

const parseOriginList = (...values: Array<string | undefined>): Set<string> => {
  const origins = new Set<string>()
  for (const value of values) {
    for (const origin of value?.split(',') ?? []) {
      const trimmed = origin.trim().replace(/\/$/, '')
      if (trimmed) {
        origins.add(trimmed)
      }
    }
  }
  return origins
}

const localCorsOrigins = new Set([
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5455',
  'http://localhost:3000',
  'http://localhost:5455',
])

// Fixed Tauri WKWebView/WebView2 origins for the Nessie desktop app.
const desktopAppCorsOrigins = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
])

type OriginPolicy = {
  origin: string | undefined
  allowedOrigins: Set<string>
  mode: AppConfig['mode']
}

/**
 * Single source of truth for "may this Origin make a credentialed request?".
 * A missing Origin (same-origin / non-browser caller) is always allowed.
 * Used by both the `@fastify/cors` origin checker and the SSE header builder so
 * the streaming endpoints can never drift from the normal CORS policy.
 */
export const isOriginAllowed = (input: OriginPolicy): boolean => {
  if (!input.origin) {
    return true
  }
  const normalizedOrigin = input.origin.replace(/\/$/, '')
  return (
    input.allowedOrigins.has(normalizedOrigin)
    || desktopAppCorsOrigins.has(normalizedOrigin)
    || (input.mode === 'local' && localCorsOrigins.has(normalizedOrigin))
  )
}

export const createCorsOriginChecker = (input: {
  allowedOrigins: Set<string>
  mode: AppConfig['mode']
}): NonNullable<FastifyCorsOptions['origin']> =>
  (origin, callback) => {
    callback(
      null,
      isOriginAllowed({
        origin: origin ?? undefined,
        allowedOrigins: input.allowedOrigins,
        mode: input.mode,
      }),
    )
  }

/**
 * CORS headers for hijacked SSE responses. `reply.hijack()` takes the response
 * out of Fastify's lifecycle, so `@fastify/cors` never runs and the manual
 * `reply.raw.writeHead` would otherwise ship no `Access-Control-Allow-Origin` —
 * silently breaking every cross-origin EventSource. Spread the result into the
 * handler's `writeHead`. Returns `{}` when the origin is absent or not allowed,
 * matching `@fastify/cors`, which then emits no allow-origin header.
 */
export const buildStreamCorsHeaders = (input: OriginPolicy): Record<string, string> => {
  if (!input.origin || !isOriginAllowed(input)) {
    return {}
  }
  return {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': input.origin,
    Vary: 'Origin',
  }
}

const MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

/**
 * Server context: owns config, the shared Prisma client, auth secret + bootstrap
 * token state, session issuance, rate limiting, and per-request auth. The
 * request-scoped visibility/PA helpers it also exposes are built by
 * `createRequestHelpers` and merged into the returned object so route modules
 * can destructure everything from a single `RouteDeps`. This was previously
 * inlined at module scope in `index.ts`; it is extracted here so the entrypoint
 * stays focused on wiring and every file stays under the 500-line cap
 * (AGENTS.md). Behaviour is unchanged — pure code movement.
 */
export const createServerContext = () => {
  const config = loadConfig()
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = config.database.url
  }
  const databaseUrl = process.env.DATABASE_URL
  const prisma = getPrismaClient({
    connectionLimit: config.database.poolMax,
    log: config.mode === 'local' ? ['warn', 'error'] : ['error'],
  })

  const allowedCorsOrigins = parseOriginList(
    process.env.NESSIE_CORS_ORIGINS,
    process.env.NESSIE_ALLOWED_ORIGINS,
    process.env.NESSIE_ADMIN_ORIGIN,
    process.env.NESSIE_WEB_ORIGIN,
    process.env.ADMIN_ORIGIN,
    process.env.WEB_ORIGIN,
  )

  const authSecret = (() => {
    if (config.auth.secret) return config.auth.secret
    if (config.mode === 'local') {
      // Local dev: generate a stable per-process secret with a warning
      console.warn('[auth] NESSIE_AUTH_SECRET not set — using ephemeral secret (tokens will not survive restarts)')
      return randomUUID()
    }
    console.error('[FATAL] NESSIE_AUTH_SECRET is required for hosted/selfHosted modes.')
    console.error('Multi-instance deployments WILL fail without a shared persistent secret.')
    process.exit(1)
  })()

  let bootstrapTokenState: BootstrapTokenState | null = null
  let bootstrapExpiryWarned = false

  const resolveBootstrapState = async (): Promise<BootstrapTokenState | null> => {
    // When an external auth provider (SSO) is configured, the first SSO login
    // provisions the owner — there is no manual owner-account bootstrap step, so
    // never arm bootstrap mode (which would otherwise hijack the login screen).
    const hasExternalAuthProvider = config.auth.providers.some(
      (provider) => provider.enabled && provider.type !== 'local-bootstrap',
    )
    if (hasExternalAuthProvider) {
      bootstrapTokenState = null
      return null
    }

    const usersExist = (await prisma.user.count()) > 0
    if (usersExist) {
      bootstrapTokenState = null
      return null
    }

    // Mint exactly once at startup (or first call). After the initial token
    // expires without being consumed, do NOT auto-rotate — return the expired
    // state so callers (e.g. POST /api/auth/bootstrap) reject with
    // TOKEN_EXPIRED. An explicit restart is required to mint a fresh token.
    if (!bootstrapTokenState) {
      bootstrapTokenState = createBootstrapTokenState()
      return bootstrapTokenState
    }

    if (isBootstrapTokenExpired(bootstrapTokenState) && !bootstrapExpiryWarned) {
      bootstrapExpiryWarned = true
      console.warn(
        '[auth] Initial bootstrap token has expired without being consumed.'
          + ' Restart the API process to mint a new bootstrap token.',
      )
    }

    return bootstrapTokenState
  }

  const clearBootstrapState = (): void => {
    bootstrapTokenState = null
  }

  const logBootstrapUrl = (state: BootstrapTokenState): void => {
    const baseUrl = `http://${config.api.host === '0.0.0.0' ? 'localhost' : config.api.host}:${config.api.port}`
    console.log('First-time setup. Open this URL to create your owner account:')
    console.log(`${baseUrl}/bootstrap?token=${state.token}`)
  }

  const getAuthorizationToken = (request: FastifyRequest): string | null => {
    const header = request.headers.authorization
    if (header) {
      const [scheme, token] = header.split(' ')
      if (scheme === 'Bearer' && token) {
        return token
      }
    }

    // Narrow exception: WebSocket upgrade requests may carry the token in the
    // query string because the browser WebSocket API cannot set custom headers.
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      const query = request.query as { token?: unknown } | undefined
      if (query && typeof query.token === 'string' && query.token) {
        return query.token
      }
    }

    return null
  }

  const authenticateRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedRequestState | null> => {
    const token = getAuthorizationToken(request)
    if (!token) {
      sendApiError(reply, 401, 'AUTH_REQUIRED', 'Missing or invalid authorization header')
      return null
    }

    const verification = verifySessionToken(token, authSecret)
    if (!verification.ok) {
      sendApiError(reply, 401, verification.code, verification.message)
      return null
    }

    const user = await prisma.user.findUnique({
      where: { id: verification.claims.sub },
    })

    if (!user) {
      sendApiError(reply, 401, 'USER_NOT_FOUND', 'User no longer exists')
      return null
    }

    // Deactivated members keep their row + history but lose access immediately
    // (their refresh tokens are revoked on deactivation, but a still-valid
    // access token must be rejected too). Only a present-and-deactivated
    // membership blocks; absent memberships (e.g. system actors) pass through.
    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: verification.claims.org,
          userId: verification.claims.sub,
        },
      },
      select: { role: true, deactivatedAt: true },
    })
    if (membership?.deactivatedAt) {
      sendApiError(reply, 403, 'ACCOUNT_DEACTIVATED', 'Your access to this organisation has been deactivated')
      return null
    }

    const actorContext = createActorContextFromClaims(verification.claims)
    // Re-resolve the role from the live membership rather than trusting the
    // (possibly stale) JWT claim, so a role change — e.g. demoting an owner —
    // takes effect on the next request instead of at token expiry. Guards like
    // requireOwner read actor.roles, so this is what makes them authoritative.
    if (membership) {
      actorContext.actor.roles = [membership.role]
    }
    request.actorContext = actorContext

    return {
      actorContext,
      claims: verification.claims,
      me: await buildMeResponse(prisma, user, verification.claims, config),
    }
  }

  const requireActorContext = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): AuthorizedActionContext | null => {
    if (request.actorContext) {
      return request.actorContext
    }

    sendApiError(reply, 401, 'AUTH_REQUIRED', 'Authentication required')
    return null
  }

  const requireOwner = (
    actorContext: AuthorizedActionContext,
    reply: FastifyReply,
  ): boolean => {
    if (actorContext.actor.roles?.includes('owner')) {
      return true
    }

    sendApiError(reply, 403, 'FORBIDDEN', 'Owner access required')
    return false
  }

  /**
   * Platform-level guard for super-admin-only surfaces (e.g. push credentials).
   * Super-admin sits ABOVE the per-organization `owner` role and is a flag on
   * the user record, so this resolves the actor against the database rather
   * than trusting the (tenant-scoped) session roles. Returns true only for a
   * human actor whose `users.super_admin` is set; otherwise sends 403/401 and
   * returns false.
   */
  const requireSuperAdmin = async (
    actorContext: AuthorizedActionContext,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'FORBIDDEN', 'Super-admin access required')
      return false
    }

    const user = await prisma.user.findUnique({
      where: { id: actorContext.actor.actorId },
      select: { superAdmin: true },
    })

    if (user?.superAdmin) {
      return true
    }

    sendApiError(reply, 403, 'FORBIDDEN', 'Super-admin access required')
    return false
  }

  // Validate a client-supplied membership role against the allowed vocabulary,
  // defaulting to 'member' when omitted. Returns null for an unknown role so the
  // route can surface a 400 instead of persisting an arbitrary string.
  const resolveMembershipRole = (role: string | undefined): MembershipRole | null => {
    if (role === undefined) {
      return 'member'
    }
    return (MEMBERSHIP_ROLES as readonly string[]).includes(role)
      ? (role as MembershipRole)
      : null
  }

  const requireUserActor = (
    actorContext: AuthorizedActionContext,
    reply: FastifyReply,
  ): actorContext is AuthorizedActionContext & {
    actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
  } => {
    if (actorContext.actor.actorType === 'user') {
      return true
    }

    sendApiError(reply, 403, 'FORBIDDEN', 'User actor required')
    return false
  }

  const parseHeaderValue = (
    value: string | string[] | undefined,
  ): string | undefined => {
    if (Array.isArray(value)) {
      return parseHeaderValue(value[0])
    }

    if (typeof value !== 'string') {
      return undefined
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  const isJsonContentType = (request: FastifyRequest): boolean => {
    const contentType = parseHeaderValue(request.headers['content-type'])
    if (!contentType) {
      return false
    }

    return /^application\/([a-z0-9.+-]+\+)?json($|;)/i.test(contentType)
  }

  const parseBearerToken = (value: string | undefined): string | undefined => {
    if (!value) {
      return undefined
    }

    const match = value.match(/^Bearer\s+(.+)$/i)
    return match?.[1]?.trim() || undefined
  }

  const readFirstHeader = (
    request: FastifyRequest,
    names: string[],
  ): string | undefined => {
    for (const name of names) {
      const value = parseHeaderValue(request.headers[name])
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }

    return undefined
  }

  const readWebhookApiKey = (request: FastifyRequest): string | undefined =>
    parseBearerToken(parseHeaderValue(request.headers['authorization'])) ??
    parseHeaderValue(request.headers['x-nessie-trigger-key'])

  const isTimingSafeMatch = (left: string | undefined, right: string | undefined): boolean => {
    if (!left || !right) {
      return false
    }

    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    if (leftBuffer.length !== rightBuffer.length) {
      return false
    }

    return timingSafeEqual(leftBuffer, rightBuffer)
  }

  const { buildLocalSession, buildSessionForUser } = createSessionIssuers({
    authSecret,
    defaultProviderType: DEFAULT_LOCAL_PROVIDER_TYPE,
    prisma,
    tokenTtlSeconds: config.auth.tokenTtlSeconds,
  })
  const checkRateLimit = createRequestRateLimitChecker()
  const rateLimiter = createRateLimiter(prisma)

  const requestHelpers = createRequestHelpers(prisma)

  return {
    config,
    prisma,
    databaseUrl,
    authSecret,
    allowedCorsOrigins,
    DEFAULT_LOCAL_PROVIDER_TYPE,
    MEMBERSHIP_ROLES,
    resolveBootstrapState,
    clearBootstrapState,
    logBootstrapUrl,
    getAuthorizationToken,
    authenticateRequest,
    requireActorContext,
    requireOwner,
    requireSuperAdmin,
    resolveMembershipRole,
    requireUserActor,
    isJsonContentType,
    parseHeaderValue,
    readWebhookApiKey,
    readFirstHeader,
    isTimingSafeMatch,
    buildLocalSession,
    buildSessionForUser,
    checkRateLimit,
    rateLimiter,
    disconnectPrismaClient,
    ...requestHelpers,
  }
}

export type ServerContext = ReturnType<typeof createServerContext>
