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
import {
  issueSessionToken,
  verifySessionToken,
  type SessionTokenClaims,
} from '../auth/session.js'
import { DEFAULT_BOOTSTRAP_RECORD_IDS } from '../db/bootstrap.js'
import { sendApiError } from './api.js'
import {
  LOCAL_AUTH_PROVIDER_ID,
  buildMeResponse,
  createActorContextFromClaims,
} from '../services/auth.js'
import { createRequestHelpers } from './request-helpers.js'

export type AppConfig = ReturnType<typeof loadConfig>

export type AuthenticatedRequestState = {
  actorContext: AuthorizedActionContext
  claims: SessionTokenClaims
  me: MeResponse
}

type RequestWithRawBody = FastifyRequest & {
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
  'http://127.0.0.1:5555',
  'http://localhost:3000',
  'http://localhost:5555',
])

export const createCorsOriginChecker = (input: {
  allowedOrigins: Set<string>
  mode: AppConfig['mode']
}): NonNullable<FastifyCorsOptions['origin']> =>
  (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }

    const normalizedOrigin = origin.replace(/\/$/, '')
    if (
      input.allowedOrigins.has(normalizedOrigin)
      || (input.mode === 'local' && localCorsOrigins.has(normalizedOrigin))
    ) {
      callback(null, true)
      return
    }

    callback(null, false)
  }

const MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

type RateLimitRule = {
  keyPrefix: string
  max: number
  windowMs: number
}

type RateLimitBucket = {
  count: number
  resetAt: number
}

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

    const actorContext = createActorContextFromClaims(verification.claims)
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

  const buildLocalSession = async (userId: string, roles: string[]) => {
    // Resolve user's actual memberships from DB instead of hardcoded bootstrap IDs
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        organizationMembers: { orderBy: { createdAt: 'asc' }, select: { organizationId: true, role: true } },
        projectMembers: { orderBy: { createdAt: 'asc' }, select: { projectId: true } },
        teamMembers: { orderBy: { createdAt: 'asc' }, select: { teamId: true } },
      },
    })

    const orgId = user?.organizationMembers[0]?.organizationId ?? DEFAULT_BOOTSTRAP_RECORD_IDS.organizationId
    const projId = user?.projectMembers[0]?.projectId ?? DEFAULT_BOOTSTRAP_RECORD_IDS.projectId
    const teamId = user?.teamMembers[0]?.teamId ?? DEFAULT_BOOTSTRAP_RECORD_IDS.teamId
    const resolvedRoles = roles.length > 0 ? roles : [user?.organizationMembers[0]?.role ?? 'member']

    return issueSessionToken(
      {
        sub: userId,
        org: orgId,
        proj: projId,
        team: teamId,
        roles: resolvedRoles,
        providerId: LOCAL_AUTH_PROVIDER_ID,
        providerType: DEFAULT_LOCAL_PROVIDER_TYPE,
      },
      authSecret,
      config.auth.tokenTtlSeconds,
    )
  }

  const buildSessionForUser = (input: {
    organizationId: string
    projectId: string
    providerId: string
    providerType: SessionTokenClaims['providerType']
    roles: string[]
    teamId: string
    userId: string
  }) =>
    issueSessionToken(
      {
        sub: input.userId,
        org: input.organizationId,
        proj: input.projectId,
        team: input.teamId,
        roles: input.roles,
        providerId: input.providerId,
        providerType: input.providerType,
      },
      authSecret,
      config.auth.tokenTtlSeconds,
    )

  const rateLimitBuckets = new Map<string, RateLimitBucket>()

  const resolveRateLimitRule = (request: FastifyRequest): RateLimitRule | null => {
    const method = request.method.toUpperCase()
    const routePath = request.routeOptions.url ?? new URL(request.url, 'http://localhost').pathname

    if (method === 'POST' && (routePath === '/api/auth/session' || routePath === '/api/auth/bootstrap')) {
      return { keyPrefix: `${method}:${routePath}`, max: 10, windowMs: 10 * 60 * 1000 }
    }

    if (method === 'POST' && routePath === '/api/threads/:threadId/messages') {
      return { keyPrefix: `${method}:${routePath}`, max: 60, windowMs: 60 * 1000 }
    }

    if (routePath.startsWith('/api/agents') && ['DELETE', 'POST', 'PUT'].includes(method)) {
      return { keyPrefix: `${method}:${routePath}`, max: 60, windowMs: 60 * 1000 }
    }

    return null
  }

  const getRateLimitClientId = (request: FastifyRequest): string => {
    const forwardedFor = parseHeaderValue(request.headers['x-forwarded-for'])
    return forwardedFor?.split(',')[0]?.trim() || request.ip
  }

  const checkRateLimit = (request: FastifyRequest): { retryAfterSeconds: number } | null => {
    const rule = resolveRateLimitRule(request)
    if (!rule) {
      return null
    }

    const now = Date.now()
    const key = `${rule.keyPrefix}:${getRateLimitClientId(request)}`
    const existingBucket = rateLimitBuckets.get(key)
    const bucket =
      existingBucket && existingBucket.resetAt > now
        ? existingBucket
        : { count: 0, resetAt: now + rule.windowMs }

    bucket.count += 1
    rateLimitBuckets.set(key, bucket)

    if (bucket.count <= rule.max) {
      return null
    }

    return {
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

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
    disconnectPrismaClient,
    ...requestHelpers,
  }
}

export type ServerContext = ReturnType<typeof createServerContext>
export type { RequestWithRawBody }
