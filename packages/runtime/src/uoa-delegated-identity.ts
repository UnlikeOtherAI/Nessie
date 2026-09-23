import crypto, { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from './ledger.js'
import { completeLedgerAttribution } from './ledger-attribution.js'
import { UoaDelegatedIdentityError, exchangeUoaDelegation } from './uoa-delegation-exchange.js'

const NESSIE_PRODUCT = 'nessie'
const DEFAULT_AUTH_BASE_URL = 'https://authentication.unlikeotherai.com'
const ASSERTION_TTL_SECONDS = 60
const CONTEXT_TTL_SECONDS = 5 * 60
const DELEGATION_CACHE_SKEW_SECONDS = 30

type IdentityLink = {
  activeOrgId: string | null
  activeTeamId: string | null
  status: string
  uoaSub: string | null
  uoaTokenVersion: number | null
}

type UoaIdentityPrisma = Pick<PrismaClient, 'productAccountLink' | 'team'>

export type UoaDelegatedIdentitySettings = {
  authBaseUrl: string
  clientSecret: string
  configUrl: string
  kid: string
  privateKeyPem: string
  sourceDomain: string
}

export type UoaDelegatedIdentityHeadersOptions = {
  accountLinkProductSlug: string
  audience: string
  delegationScope: 'ai.invoke' | 'billing.read'
  requireActiveTeam?: boolean
  requireUoaIdentity?: boolean
  toolCallId?: string | null
}

export type UoaProductIdentity = {
  organizationId: string | null
  subject: string
  teamId: string | null
  tokenVersion: number
}

/**
 * A short-lived assertion of the UOA subject selected in a Nessie session.
 *
 * It is deliberately not an access token: UOA verifies it against the
 * product's configured JWKS and re-resolves the named user, epoch, and active
 * team before authorizing a request. This lets a product delegate one
 * current session without retaining a UOA bearer credential.
 */
export type UoaSubjectAssertionIdentity = {
  organizationId: string
  subject: string
  teamId: string
  tokenVersion: number
}

export type UoaDelegatedIdentityService = {
  requestHeaders: (
    attribution: LedgerAttribution,
    options: UoaDelegatedIdentityHeadersOptions,
  ) => Promise<Record<string, string>>
}

type DelegationCacheEntry = {
  expiresAt: number
  token: string
}

const envValue = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const value = env[name]?.trim()
  return value ? value : null
}

/**
 * Load the RS256 and confidential UOA token-exchange settings shared by every
 * first-party Nessie application boundary. A null result is permitted only to
 * let local/direct-provider development decide whether that boundary is in use.
 */
export const loadUoaDelegatedIdentitySettings = (
  env: NodeJS.ProcessEnv = process.env,
): UoaDelegatedIdentitySettings | null => {
  const sourceDomain = envValue(env, 'UOA_DOMAIN')
  const configUrl = envValue(env, 'UOA_CONFIG_URL')
  const kid = envValue(env, 'UOA_CONFIG_JWT_KID')
  const privateKeyB64 = envValue(env, 'UOA_CONFIG_JWT_PRIVATE_KEY_B64')
  const clientSecret = envValue(env, 'UOA_CLIENT_SECRET')
  if (!sourceDomain || !configUrl || !kid || !privateKeyB64 || !clientSecret) {
    return null
  }
  return {
    authBaseUrl: (
      envValue(env, 'UOA_BASE_URL') ?? DEFAULT_AUTH_BASE_URL
    ).replace(/\/$/, ''),
    clientSecret,
    configUrl,
    kid,
    privateKeyPem: Buffer.from(privateKeyB64, 'base64').toString('utf8'),
    sourceDomain,
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const signJwt = (
  settings: UoaDelegatedIdentitySettings,
  claims: Record<string, unknown>,
): string => {
  const header = encodeJson({ alg: 'RS256', kid: settings.kid, typ: 'JWT' })
  const payload = encodeJson(claims)
  const signingInput = `${header}.${payload}`
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput), settings.privateKeyPem)
    .toString('base64url')
  return `${signingInput}.${signature}`
}

const resolveUserId = (attribution: LedgerAttribution): string | null =>
  attribution.userId
  ?? (attribution.actorType === 'user' ? attribution.actorId : null)

/**
 * Does the attributed local team still advertise exactly the UOA team this
 * identity names?
 *
 * Exported because the scheduled-trigger fire gate must ask precisely this
 * question before dispatching. It used to check only the account link, so a
 * trigger could pass, create a run, and have the run die here at its first
 * inference — silently, since unattended failures post nothing. Two copies of
 * this predicate would be free to drift back apart, which is exactly the gap
 * that produced that outage.
 */
export const activeTeamMatchesAttribution = async (
  prisma: UoaIdentityPrisma,
  attribution: LedgerAttribution,
  identity: UoaProductIdentity | null,
): Promise<boolean> => {
  if (
    !identity?.organizationId
    || !identity.teamId
    || !attribution.teamId
  ) {
    return false
  }
  const team = await prisma.team.findFirst({
    where: {
      id: attribution.teamId,
      project: { organizationId: attribution.organizationId },
    },
    select: {
      externalOrgId: true,
      externalTeamId: true,
    },
  })
  return Boolean(
    team?.externalOrgId
    && team.externalTeamId
    && team.externalOrgId === identity.organizationId
    && team.externalTeamId === identity.teamId,
  )
}

const contextSubject = (
  attribution: LedgerAttribution,
  link: IdentityLink | null,
): string =>
  link?.uoaSub
  ?? `nessie:${resolveUserId(attribution) ?? `${attribution.actorType ?? 'actor'}:${attribution.actorId}`}`

const normalizeAudience = (audience: string): string => {
  const parsed = new URL(audience)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Delegated identity audience must be an HTTP(S) URL.')
  }
  return parsed.origin
}

const buildNessieContext = (
  settings: UoaDelegatedIdentitySettings,
  attribution: LedgerAttribution,
  link: IdentityLink | null,
  audience: string,
  nowSeconds: number,
  options: UoaDelegatedIdentityHeadersOptions,
): string =>
  signJwt(settings, {
    iss: `https://${settings.sourceDomain}`,
    aud: audience,
    sub: contextSubject(attribution, link),
    source_domain: settings.sourceDomain,
    user_id: resolveUserId(attribution),
    organization_id: attribution.organizationId,
    org_id: attribution.organizationId,
    project_id: attribution.projectId ?? null,
    team_id: attribution.teamId ?? null,
    channel_id: attribution.channelId ?? null,
    thread_id: attribution.threadId ?? null,
    task_id: attribution.taskId ?? null,
    run_id: attribution.runId ?? null,
    agent_id: attribution.agentId ?? null,
    agent_kind: attribution.agentKind ?? null,
    system_component: attribution.systemComponent ?? null,
    actor_id: attribution.actorId,
    request_id: attribution.requestId ?? null,
    correlation_id: attribution.correlationId ?? null,
    tool_call_id: options.toolCallId ?? attribution.toolCallId ?? null,
    iat: nowSeconds,
    exp: nowSeconds + CONTEXT_TTL_SECONDS,
    jti: randomUUID(),
  })

const buildSubjectAssertion = (
  settings: UoaDelegatedIdentitySettings,
  link: IdentityLink & { uoaSub: string; uoaTokenVersion: number },
  nowSeconds: number,
): string =>
  signJwt(settings, {
    iss: settings.sourceDomain,
    aud: `${settings.authBaseUrl}/auth/token`,
    sub: link.uoaSub,
    source_domain: settings.sourceDomain,
    tv: link.uoaTokenVersion,
    ...(link.activeOrgId && link.activeTeamId
      ? {
          active: {
            orgId: link.activeOrgId,
            teamId: link.activeTeamId,
          },
        }
      : {}),
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
    jti: randomUUID(),
  })

export const createUoaSubjectAssertion = (
  settings: UoaDelegatedIdentitySettings,
  identity: UoaSubjectAssertionIdentity,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string =>
  signJwt(settings, {
    iss: settings.sourceDomain,
    aud: audience,
    sub: identity.subject,
    source_domain: settings.sourceDomain,
    tv: identity.tokenVersion,
    active: {
      orgId: identity.organizationId,
      teamId: identity.teamId,
    },
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
    jti: randomUUID(),
  })

export const loadUoaProductIdentity = async (
  prisma: UoaIdentityPrisma,
  attribution: LedgerAttribution,
  productSlug: string,
): Promise<UoaProductIdentity | null> => {
  const userId = resolveUserId(attribution)
  const sessionIdentity = attribution.uoaIdentity
  if (!userId || !sessionIdentity) return null
  const link = await prisma.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: attribution.organizationId,
        userId,
        productSlug,
      },
    },
    select: {
      status: true,
      uoaSub: true,
      uoaTokenVersion: true,
    },
  })
  if (
    link?.status !== 'linked'
    || sessionIdentity.tokenVersion === null
    || link.uoaSub !== sessionIdentity.subject
    || (link.uoaTokenVersion ?? null) !== sessionIdentity.tokenVersion
  ) {
    return null
  }
  return {
    organizationId: sessionIdentity.organizationId,
    subject: sessionIdentity.subject,
    teamId: sessionIdentity.teamId,
    tokenVersion: sessionIdentity.tokenVersion,
  }
}

const delegationCacheKey = (
  attribution: LedgerAttribution,
  identity: UoaProductIdentity,
  options: UoaDelegatedIdentityHeadersOptions,
  audience: string,
): string =>
  [
    NESSIE_PRODUCT,
    options.accountLinkProductSlug,
    options.delegationScope,
    audience,
    attribution.organizationId,
    resolveUserId(attribution),
    identity.subject,
    identity.organizationId,
    identity.teamId,
    identity.tokenVersion,
  ].join(':')

export const createUoaDelegatedIdentityService = (input: {
  prisma: UoaIdentityPrisma
  settings: UoaDelegatedIdentitySettings
  fetchImpl?: typeof fetch
  now?: () => number
}): UoaDelegatedIdentityService => {
  const fetchImpl = input.fetchImpl ?? fetch
  const now = input.now ?? Date.now
  const cache = new Map<string, DelegationCacheEntry>()

  const exchangeDelegation = async (
    attribution: LedgerAttribution,
    identity: UoaProductIdentity,
    options: UoaDelegatedIdentityHeadersOptions,
    audience: string,
    nowSeconds: number,
  ): Promise<string> => {
    const cacheKey = delegationCacheKey(attribution, identity, options, audience)
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt - DELEGATION_CACHE_SKEW_SECONDS > nowSeconds) {
      return cached.token
    }

    const subjectToken = buildSubjectAssertion(input.settings, {
      activeOrgId: identity.organizationId,
      activeTeamId: identity.teamId,
      status: 'linked',
      uoaSub: identity.subject,
      uoaTokenVersion: identity.tokenVersion,
    }, nowSeconds)
    const exchanged = await exchangeUoaDelegation(input.settings, fetchImpl, {
      subjectToken,
      scope: options.delegationScope,
      audience,
      tokenVersion: identity.tokenVersion,
      nowSeconds,
      fallbackTtlSeconds: CONTEXT_TTL_SECONDS,
    })
    cache.set(cacheKey, exchanged)
    return exchanged.token
  }

  return {
    async requestHeaders(attribution, options) {
      const completeAttribution = completeLedgerAttribution(attribution)
      const audience = normalizeAudience(options.audience)
      const nowSeconds = Math.floor(now() / 1000)
      const linkedIdentity = await loadUoaProductIdentity(
        input.prisma,
        completeAttribution,
        options.accountLinkProductSlug,
      )
      const teamMatches = linkedIdentity
        ? await activeTeamMatchesAttribution(
          input.prisma,
          completeAttribution,
          linkedIdentity,
        )
        : false
      const identity = teamMatches ? linkedIdentity : null
      if (options.requireUoaIdentity && !linkedIdentity) {
        throw new UoaDelegatedIdentityError(
          'UOA_IDENTITY_REQUIRED',
          `A linked UnlikeOtherAI SSO identity is required for ${options.accountLinkProductSlug}.`,
        )
      }
      if (
        linkedIdentity
        && !teamMatches
        && (options.requireActiveTeam || options.requireUoaIdentity)
      ) {
        throw new UoaDelegatedIdentityError(
          'UOA_ACTIVE_TEAM_REQUIRED',
          `The active UnlikeOtherAI organization/team must match the originating Nessie team for ${options.accountLinkProductSlug}.`,
        )
      }

      const link = identity
        ? {
            activeOrgId: identity.organizationId,
            activeTeamId: identity.teamId,
            status: 'linked',
            uoaSub: identity.subject,
            uoaTokenVersion: identity.tokenVersion,
          }
        : null
      const headers: Record<string, string> = {
        'X-Nessie-Context': buildNessieContext(
          input.settings,
          completeAttribution,
          link,
          audience,
          nowSeconds,
          options,
        ),
      }
      if (identity) {
        headers['X-UOA-Delegation'] = await exchangeDelegation(
          completeAttribution,
          identity,
          options,
          audience,
          nowSeconds,
        )
      }
      return headers
    },
  }
}
