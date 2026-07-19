import crypto, { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from './ledger.js'
import { completeLedgerAttribution } from './ledger-attribution.js'

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
const NESSIE_PRODUCT = 'nessie'
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'
const DEFAULT_AUTH_BASE_URL = 'https://authentication.unlikeotherai.com'
const DEFAULT_LEDGER_AUDIENCE = 'https://ledger.unlikeotherai.com'
const ASSERTION_TTL_SECONDS = 60
const CONTEXT_TTL_SECONDS = 5 * 60
const DELEGATION_CACHE_SKEW_SECONDS = 30

type IdentityLink = {
  activeOrgId: string | null
  activeTeamId: string | null
  status: string
  uoaSub: string | null
}

type LedgerIdentityPrisma = Pick<PrismaClient, 'productAccountLink'>

export type LedgerIdentitySettings = {
  authBaseUrl: string
  clientSecret: string
  configUrl: string
  kid: string
  ledgerAudience: string
  privateKeyPem: string
  sourceDomain: string
}

export type LedgerIdentityHeadersOptions = {
  delegationScope?: 'ai.invoke' | 'billing.read'
  requireUoaIdentity?: boolean
  toolCallId?: string | null
}

export type LedgerUoaIdentity = {
  organizationId: string | null
  subject: string
  teamId: string | null
}

export type LedgerIdentityService = {
  requestHeaders: (
    attribution: LedgerAttribution,
    options?: LedgerIdentityHeadersOptions,
  ) => Promise<Record<string, string>>
}

type DelegationCacheEntry = {
  expiresAt: number
  token: string
}

export class LedgerIdentityError extends Error {
  constructor(
    public readonly code:
      | 'LEDGER_IDENTITY_UNCONFIGURED'
      | 'LEDGER_UOA_IDENTITY_REQUIRED'
      | 'LEDGER_UOA_TOKEN_EXCHANGE_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'LedgerIdentityError'
  }
}

const envValue = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const value = env[name]?.trim()
  return value ? value : null
}

/**
 * Load the signing and UOA relying-party settings already used by Nessie SSO.
 * Returning null keeps local/direct-provider development operational; a
 * Ledger-routed call fails explicitly at dispatch when these settings are
 * absent.
 */
export const loadLedgerIdentitySettings = (
  env: NodeJS.ProcessEnv = process.env,
): LedgerIdentitySettings | null => {
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
    ledgerAudience:
      envValue(env, 'LEDGER_PUBLIC_URL')?.replace(/\/$/, '')
      ?? DEFAULT_LEDGER_AUDIENCE,
    privateKeyPem: Buffer.from(privateKeyB64, 'base64').toString('utf8'),
    sourceDomain,
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const signJwt = (
  settings: LedgerIdentitySettings,
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

const decodeJwtExpiry = (token: string, fallback: number): number => {
  const payload = token.split('.')[1]
  if (!payload) return fallback
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp : fallback
  } catch {
    return fallback
  }
}

const resolveUserId = (attribution: LedgerAttribution): string | null =>
  attribution.userId
  ?? (attribution.actorType === 'user' ? attribution.actorId : null)

const contextSubject = (
  attribution: LedgerAttribution,
  link: IdentityLink | null,
): string =>
  link?.uoaSub
  ?? `nessie:${resolveUserId(attribution) ?? `${attribution.actorType ?? 'actor'}:${attribution.actorId}`}`

const buildNessieContext = (
  settings: LedgerIdentitySettings,
  attribution: LedgerAttribution,
  link: IdentityLink | null,
  nowSeconds: number,
  options: LedgerIdentityHeadersOptions,
): string =>
  signJwt(settings, {
    iss: `https://${settings.sourceDomain}`,
    aud: settings.ledgerAudience,
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
    tool_call_id: options.toolCallId ?? null,
    iat: nowSeconds,
    exp: nowSeconds + CONTEXT_TTL_SECONDS,
    jti: randomUUID(),
  })

const buildSubjectAssertion = (
  settings: LedgerIdentitySettings,
  link: IdentityLink & { uoaSub: string },
  nowSeconds: number,
): string =>
  signJwt(settings, {
    iss: settings.sourceDomain,
    aud: `${settings.authBaseUrl}/auth/token`,
    sub: link.uoaSub,
    source_domain: settings.sourceDomain,
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

export const loadLedgerUoaIdentity = async (
  prisma: LedgerIdentityPrisma,
  attribution: LedgerAttribution,
): Promise<LedgerUoaIdentity | null> => {
  const userId = resolveUserId(attribution)
  if (!userId) return null
  const link = await prisma.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: attribution.organizationId,
        userId,
        productSlug: DEEP_WATER_PRODUCT_SLUG,
      },
    },
    select: {
      activeOrgId: true,
      activeTeamId: true,
      status: true,
      uoaSub: true,
    },
  })
  if (link?.status !== 'linked' || !link.uoaSub) {
    return null
  }
  return {
    organizationId: link.activeOrgId,
    subject: link.uoaSub,
    teamId: link.activeTeamId,
  }
}

const delegationCacheKey = (
  attribution: LedgerAttribution,
  identity: LedgerUoaIdentity,
  scope: LedgerIdentityHeadersOptions['delegationScope'],
): string =>
  [
    NESSIE_PRODUCT,
    scope,
    attribution.organizationId,
    resolveUserId(attribution),
    identity.subject,
    identity.organizationId,
    identity.teamId,
  ].join(':')

export const createLedgerIdentityService = (input: {
  prisma: LedgerIdentityPrisma
  settings: LedgerIdentitySettings
  fetchImpl?: typeof fetch
  now?: () => number
}): LedgerIdentityService => {
  const fetchImpl = input.fetchImpl ?? fetch
  const now = input.now ?? Date.now
  const cache = new Map<string, DelegationCacheEntry>()

  const exchangeDelegation = async (
    attribution: LedgerAttribution,
    identity: LedgerUoaIdentity,
    scope: NonNullable<LedgerIdentityHeadersOptions['delegationScope']>,
    nowSeconds: number,
  ): Promise<string> => {
    const cacheKey = delegationCacheKey(attribution, identity, scope)
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt - DELEGATION_CACHE_SKEW_SECONDS > nowSeconds) {
      return cached.token
    }

    const subjectToken = buildSubjectAssertion(input.settings, {
      activeOrgId: identity.organizationId,
      activeTeamId: identity.teamId,
      status: 'linked',
      uoaSub: identity.subject,
    }, nowSeconds)
    const clientHash = crypto
      .createHash('sha256')
      .update(input.settings.sourceDomain + input.settings.clientSecret)
      .digest('hex')
    const exchangeUrl = new URL(`${input.settings.authBaseUrl}/auth/token`)
    exchangeUrl.searchParams.set('config_url', input.settings.configUrl)
    const response = await fetchImpl(exchangeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientHash}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: TOKEN_EXCHANGE_GRANT,
        product: NESSIE_PRODUCT,
        scope,
        subject_token_type: JWT_TOKEN_TYPE,
        resource: input.settings.ledgerAudience,
        subject_token: subjectToken,
      }),
    })
    if (!response.ok) {
      throw new LedgerIdentityError(
        'LEDGER_UOA_TOKEN_EXCHANGE_FAILED',
        `UOA delegation exchange failed with status ${response.status}.`,
      )
    }
    const body = await response.json() as {
      access_token?: unknown
      expires_in?: unknown
    }
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new LedgerIdentityError(
        'LEDGER_UOA_TOKEN_EXCHANGE_FAILED',
        'UOA delegation exchange returned no access token.',
      )
    }
    const fallbackExpiry =
      nowSeconds
      + (typeof body.expires_in === 'number' ? body.expires_in : CONTEXT_TTL_SECONDS)
    cache.set(cacheKey, {
      token: body.access_token,
      expiresAt: decodeJwtExpiry(body.access_token, fallbackExpiry),
    })
    return body.access_token
  }

  return {
    async requestHeaders(attribution, options = {}) {
      const completeAttribution = completeLedgerAttribution(attribution)
      const nowSeconds = Math.floor(now() / 1000)
      const identity = await loadLedgerUoaIdentity(
        input.prisma,
        completeAttribution,
      )
      if (options.requireUoaIdentity && !identity) {
        throw new LedgerIdentityError(
          'LEDGER_UOA_IDENTITY_REQUIRED',
          'Ledger requires a linked UnlikeOtherAI SSO identity for the originating user.',
        )
      }

      const headers: Record<string, string> = {
        'X-Nessie-Context': buildNessieContext(
          input.settings,
          completeAttribution,
          identity
            ? {
                activeOrgId: identity.organizationId,
                activeTeamId: identity.teamId,
                status: 'linked',
                uoaSub: identity.subject,
              }
            : null,
          nowSeconds,
          options,
        ),
      }
      if (identity) {
        headers['X-UOA-Delegation'] = await exchangeDelegation(
          completeAttribution,
          identity,
          options.delegationScope ?? 'ai.invoke',
          nowSeconds,
        )
      }
      return headers
    },
  }
}

export const createLedgerIdentityServiceFromEnv = (
  prisma: LedgerIdentityPrisma,
  env: NodeJS.ProcessEnv = process.env,
): LedgerIdentityService | null => {
  const settings = loadLedgerIdentitySettings(env)
  return settings ? createLedgerIdentityService({ prisma, settings }) : null
}

export const isLedgerEndpoint = (
  url: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (!url) return false
  const audience =
    envValue(env, 'LEDGER_PUBLIC_URL')?.replace(/\/$/, '')
    ?? DEFAULT_LEDGER_AUDIENCE
  try {
    return new URL(url).origin === new URL(audience).origin
  } catch {
    return false
  }
}

/**
 * Ledger's generic provider proxy is `/v1/:serviceId/*`. The deployment may
 * configure the canonical OpenAI route as its base URL; every inference
 * service rewrites that final service segment to the provider selected for the
 * actual stage so Kimi, MiniMax, and custom adapters cannot fall through the
 * OpenAI route.
 */
export const resolveLedgerServiceBaseUrl = (
  baseUrl: string | null | undefined,
  serviceId: string,
): string | undefined => {
  if (!baseUrl || !isLedgerEndpoint(baseUrl)) {
    return baseUrl ?? undefined
  }
  const normalizedServiceId = serviceId.trim()
  if (!normalizedServiceId || normalizedServiceId.includes('/')) {
    throw new Error('Ledger inference serviceId must be a non-empty URL segment.')
  }
  const url = new URL(baseUrl)
  url.pathname = `/v1/${encodeURIComponent(normalizedServiceId)}`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}
