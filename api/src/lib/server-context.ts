import { randomUUID, timingSafeEqual } from 'node:crypto'

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
import {
  isSessionTokenRevoked,
  verifySessionToken,
  type SessionTokenClaims,
} from '../auth/session.js'
import { sendApiError } from './api.js'
import {
  buildMeResponse,
  createActorContextFromClaims,
} from '../services/auth.js'
import { createAuthSessionRevocationChecker } from '../services/auth-session-registry.js'
import { hasActiveUserSession } from '../services/refresh-session-management.js'
import { createSessionIssuers } from '../services/session-issuers.js'
import { createRequestRateLimitChecker } from './rate-limit.js'
import { createRequestHelpers } from './request-helpers.js'
import { createRateLimiter } from '../services/rate-limit.js'
import { parseOriginList } from './server-origin-policy.js'

export {
  createFastifyTrustProxyConfig,
  getRateLimitClientId,
} from './rate-limit.js'
export {
  buildStreamCorsHeaders,
  createCorsOriginChecker,
  isOriginAllowed,
} from './server-origin-policy.js'

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

    // Revocation: a forced sign-out bumps User.tokenVersion, which
    // invalidates every access token minted at an older generation.
    if (isSessionTokenRevoked(verification.claims, user.tokenVersion)) {
      sendApiError(reply, 401, 'TOKEN_REVOKED', 'Session has been revoked')
      return null
    }

    // Session-row revocation (workstream 1e, S9/SB-04): DELETE /sessions and
    // password change set AuthSession.revokedAt for the targeted sids, so a
    // revoked session's access JWT stops working now instead of surviving its
    // full ~30-minute TTL. Deliberate rollout-safety tradeoff: a sid with NO
    // AuthSession row is ACCEPTED — pre-migration tokens and any issuance
    // path not yet writing rows keep working; the check fails closed only on
    // an explicit revoked row and tightens to fail-closed-on-absence once
    // issuance is proven to cover every path. Staleness: the checker caches
    // the revoked boolean per process for ~30s, so across replicas a revoked
    // sid can keep authenticating on one replica for up to the TTL.
    if (await isSessionRevokedById(verification.claims.sid)) {
      sendApiError(reply, 401, 'TOKEN_REVOKED', 'Session has been revoked')
      return null
    }

    // Exact-session revocation: logout revokes only the bearer's `sid`, never
    // the whole user generation, so the live check must be per-session. With
    // no unrevoked, unexpired refresh row for this exact `sid`, the session
    // was logged out and its access token stops working now, not at expiry.
    if (
      !(await hasActiveUserSession(
        prisma,
        verification.claims.sub,
        verification.claims.sid,
      ))
    ) {
      sendApiError(reply, 401, 'TOKEN_REVOKED', 'Session has been revoked')
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

  const isSessionRevokedById = createAuthSessionRevocationChecker(prisma)

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
    // Exposed so the route that revokes a session can drop it from this
    // process's cache immediately, instead of honouring the token for the
    // rest of the TTL on the very replica that performed the revocation.
    invalidateSessionRevocationCache: isSessionRevokedById.invalidate,
    checkRateLimit,
    rateLimiter,
    disconnectPrismaClient,
    ...requestHelpers,
  }
}

export type ServerContext = ReturnType<typeof createServerContext>
