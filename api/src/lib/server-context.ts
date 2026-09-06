import { randomUUID, timingSafeEqual } from 'node:crypto'

import type { FastifyReply, FastifyRequest } from 'fastify'
import { loadConfig } from '@nessie/config'
import {
  isAdminActor,
  type AuthorizedActionContext,
  type MeResponse,
} from '@nessie/schemas'
import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'
import {
  ensureBootstrapToken,
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
import { createRequestHelpers } from './request-helpers.js'
import { createRateLimiter } from '../services/rate-limit.js'
import { lockBootstrapInitialization } from '../db/seed.js'
import { AUTH_LOCK_TRANSACTION_OPTIONS } from '../services/user-session-lock.js'
import { parseOriginList } from './server-origin-policy.js'

export { createFastifyTrustProxyConfig } from './rate-limit.js'
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

/**
 * A deployment that cannot be started as configured.
 *
 * `createServerContext` used to `process.exit(1)` on a missing
 * `NESSIE_AUTH_SECRET`. That made merely *importing* the module capable of
 * killing the process, so no test could construct a context to assert the rule
 * and any importer inherited the exit (2026-09-05 review, FO3-5). The refusal
 * is unchanged — only its delivery: `startApiServer` catches this, logs it, and
 * exits 1.
 */
export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerConfigurationError'
  }
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

  /**
   * Base domain for team hostnames, e.g. `nessie.works`, so a team lives at
   * `<team>.<org>.nessie.works`. Unset means this deployment does not route
   * teams by hostname at all — every existing install, until it opts in.
   */
  const teamHostBaseDomain = process.env.NESSIE_TEAM_HOST_BASE_DOMAIN?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '') || undefined

  /**
   * Shared secret the edge presents when asking whether a hostname may be
   * issued a certificate (`GET /api/hosts/tls-check`).
   *
   * The answer is "does this team exist", which this product deliberately keeps
   * behind authentication — `/api/hosts/team` is authenticated and the branded
   * team page never names its team, precisely so a guessable address cannot be
   * confirmed. An unauthenticated gate would hand that back through the side
   * door, so the gate is only open to a caller holding this.
   *
   * Unset means the gate refuses everything, which is the safe direction: an
   * install that has not configured it cannot be used as an existence oracle,
   * and on-demand issuance simply does not happen.
   */
  const tlsCheckKey = process.env.NESSIE_TLS_CHECK_KEY?.trim() || undefined

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
    throw new ServerConfigurationError(
      'NESSIE_AUTH_SECRET is required for hosted/selfHosted modes.'
        + ' Multi-instance deployments WILL fail without a shared persistent secret.',
    )
  })()

  /**
   * The install's owner-bootstrap token, read from Postgres so every replica
   * agrees on it.
   *
   * It used to be minted per process with `randomUUID()` and held in this
   * closure (audit 1.2): each replica logged a different setup URL and an
   * exchange that landed anywhere else failed `TOKEN_INVALID`. There is no
   * `clearBootstrapState` any more either — clearing one replica's copy was
   * the same defect from the other end. Consumption is now the conditional
   * UPDATE in `POST /api/auth/bootstrap`.
   */
  const resolveBootstrapState = async (): Promise<BootstrapTokenState | null> => {
    // When an external auth provider (SSO) is configured, the first SSO login
    // provisions the owner — there is no manual owner-account bootstrap step, so
    // never arm bootstrap mode (which would otherwise hijack the login screen).
    const hasExternalAuthProvider = config.auth.providers.some(
      (provider) => provider.enabled && provider.type !== 'local-bootstrap',
    )
    if (hasExternalAuthProvider) return null

    // Unauthenticated GET /api/auth/me lands here on every page load of a live
    // install, so answer the common case with one count and never open a
    // locked transaction for it.
    if ((await prisma.user.count()) > 0) return null

    return prisma.$transaction(async (transaction) => {
      // The seeder's own lock name: minting and owner-creation serialise
      // against each other, so simultaneous boots settle on one token instead
      // of each writing their own.
      await lockBootstrapInitialization(transaction)
      if ((await transaction.user.count()) > 0) return null
      return ensureBootstrapToken(transaction)
    }, AUTH_LOCK_TRANSACTION_OPTIONS)
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
    // access token must be rejected too).
    //
    // An ABSENT membership is the other half. It has to keep passing through
    // for the tenants that legitimately have none — the only writers of these
    // rows are `db/seed.ts` (bootstrap), `services/users.ts` (local account
    // creation) and `services/team-principal.ts` (a UOA login), and
    // `buildLocalSession` falls back to the bootstrap organisation id for a
    // user with no membership at all, so an unbound install can hold a session
    // whose `org` claim names no live row. In a **UOA-bound** organisation
    // there is no such principal: every session there was minted from a proven
    // UOA membership, so an absent row means the membership was withdrawn
    // (`reconcileUoaMembershipProjection`) and the still-valid access token
    // must stop working now rather than at expiry (2026-09-05 review, FO2-1).
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
    if (!membership) {
      const organization = await prisma.organization.findUnique({
        where: { id: verification.claims.org },
        select: { externalOrgId: true },
      })
      if (organization?.externalOrgId) {
        sendApiError(
          reply,
          403,
          'ORGANIZATION_MEMBERSHIP_REQUIRED',
          'Your membership of this organisation is no longer held by UnlikeOtherAI',
        )
        return null
      }
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
   * Owner **or** organisation admin, the pair `ORGANIZATION_ADMIN_ROLES`
   * defines. It sits beside `requireOwner` rather than replacing it: several
   * decisions are still deliberately owner-only, and this is not a substitute
   * for those.
   *
   * It exists because the same predicate was spelled inline in three route
   * modules while the contract that owns it lived in `@nessie/schemas`
   * (2026-09-05 review, FO1-3), so each new route re-decided which spelling
   * applied. `actor.roles` is re-resolved from the live `OrganizationMember`
   * row on every request (`authenticateRequest`), so a demotion lands here on
   * the next call.
   */
  const requireOrgAdmin = (
    actorContext: AuthorizedActionContext,
    reply: FastifyReply,
  ): boolean => {
    if (isAdminActor(actorContext)) {
      return true
    }

    sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
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
  // One limiter, one store, one IP canonicalisation: the in-process `Map` that
  // used to sit beside this one with its own hard-coded thresholds is gone
  // (2026-09-05 review, FO3-3/FO4-1). The API-wide per-IP *check* is built by
  // `registerGlobalAuthHook` from this limiter and `config`, so the context
  // carries the limiter rather than a second, pre-bound closure over it.
  const rateLimiter = createRateLimiter(prisma)

  const requestHelpers = createRequestHelpers(prisma)

  /**
   * Guard for changing a project's *shape* — its boards, columns, custom
   * fields and data sources. An organisation owner passes, and so does
   * somebody the project itself records as its owner or admin.
   *
   * Board mutations were owner-only while a project had one board of four
   * columns; with many boards per project that is unworkable, and
   * `ProjectMember.role` is Nessie-owned data (a project has no UOA
   * counterpart), so gating on it adds no second identity authority.
   */
  const requireProjectAdmin = async (
    actorContext: AuthorizedActionContext,
    projectId: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (await requestHelpers.canActorAdministerProject(actorContext, projectId)) {
      return true
    }
    sendApiError(reply, 403, 'FORBIDDEN', 'Project administrator access required')
    return false
  }

  return {
    config,
    prisma,
    databaseUrl,
    authSecret,
    allowedCorsOrigins,
    teamHostBaseDomain,
    tlsCheckKey,
    DEFAULT_LOCAL_PROVIDER_TYPE,
    MEMBERSHIP_ROLES,
    resolveBootstrapState,
    logBootstrapUrl,
    getAuthorizationToken,
    authenticateRequest,
    requireActorContext,
    requireOwner,
    requireOrgAdmin,
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
    rateLimiter,
    disconnectPrismaClient,
    ...requestHelpers,
    requireProjectAdmin,
  }
}

export type ServerContext = ReturnType<typeof createServerContext>
