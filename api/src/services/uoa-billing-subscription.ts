import type { PrismaClient } from '@prisma/client'
import {
  createPrivateKey,
  randomUUID,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto'
import {
  UoaBillingCheckoutResponseSchema,
  UoaBillingPortalResponseSchema,
  UoaBillingSubscriptionSummarySchema,
  type AuthorizedActionContext,
  type UoaBillingCheckoutResponse,
  type UoaBillingPortalResponse,
  type UoaBillingSubscriptionSummary,
} from '@nessie/schemas'
import {
  BillingWorkspaceError,
  resolveBillingWorkspace,
  type BillingWorkspacePrisma,
} from './billing-workspace.js'

export const NESSIE_UOA_BILLING_APP_KEY_ENV =
  'UOA_BILLING_APP_KEY_NESSIE'
export const NESSIE_UOA_BILLING_ACTOR_KEY_ENV =
  'UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE'

const NESSIE_PRODUCT = 'nessie'
const BILLING_ACTOR_TTL_SECONDS = 45
const DEFAULT_UOA_BASE_URL = 'https://authentication.unlikeotherai.com'
const DEFAULT_ADMIN_URL = 'http://localhost:5455'

type BillingSubscriptionPrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

type PrivateActorJwk = {
  alg?: string
  d: string
  e: string
  kid: string
  kty: 'RSA'
  n: string
  use?: string
}

type BillingSettings = {
  actorAudience: string
  actorIssuer: string
  actorKey: KeyObject
  actorKeyId: string
  adminUrl: string
  appKey: string
  baseUrl: string
}

export class UoaBillingSubscriptionError extends Error {
  constructor(
    public readonly code:
      | 'UOA_BILLING_CONTEXT_MISMATCH'
      | 'UOA_BILLING_FORBIDDEN'
      | 'UOA_BILLING_RESPONSE_INVALID'
      | 'UOA_BILLING_SSO_REQUIRED'
      | 'UOA_BILLING_UNCONFIGURED'
      | 'UOA_BILLING_UPSTREAM_REJECTED',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message)
    this.name = 'UoaBillingSubscriptionError'
  }
}

const envValue = (
  env: NodeJS.ProcessEnv,
  name: string,
): string | null => env[name]?.trim() || null

const normalizeOrigin = (
  value: string,
  name: string,
  allowHttp: boolean,
): string => {
  try {
    const url = new URL(value)
    if (
      (!allowHttp && url.protocol !== 'https:')
      || (allowHttp && !['http:', 'https:'].includes(url.protocol))
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      throw new Error('invalid')
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_UNCONFIGURED',
      `${name} must be a credential-free ${allowHttp ? 'HTTP(S)' : 'HTTPS'} URL.`,
      503,
    )
  }
}

const parsePrivateActorKey = (value: string): {
  key: KeyObject
  keyId: string
} => {
  try {
    const parsed = JSON.parse(value) as PrivateActorJwk
    if (
      parsed.kty !== 'RSA'
      || !parsed.kid
      || !parsed.n
      || !parsed.e
      || !parsed.d
      || (parsed.alg && parsed.alg !== 'RS256')
      || (parsed.use && parsed.use !== 'sig')
    ) {
      throw new Error('invalid')
    }
    return {
      key: createPrivateKey({ format: 'jwk', key: parsed }),
      keyId: parsed.kid,
    }
  } catch {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_UNCONFIGURED',
      `${NESSIE_UOA_BILLING_ACTOR_KEY_ENV} must be a private RS256 JWK with a kid.`,
      503,
    )
  }
}

const loadBillingSettings = (
  env: NodeJS.ProcessEnv,
): BillingSettings => {
  const appKey = envValue(env, NESSIE_UOA_BILLING_APP_KEY_ENV)
  const privateJwk = envValue(env, NESSIE_UOA_BILLING_ACTOR_KEY_ENV)
  if (!appKey || !/^uoa_app_[A-Za-z0-9_-]{16,}$/.test(appKey) || !privateJwk) {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_UNCONFIGURED',
      `Subscription management requires ${NESSIE_UOA_BILLING_APP_KEY_ENV} and ${NESSIE_UOA_BILLING_ACTOR_KEY_ENV}.`,
      503,
    )
  }
  const production = envValue(env, 'NODE_ENV') === 'production'
  const baseUrl = normalizeOrigin(
    envValue(env, 'UOA_BASE_URL') ?? DEFAULT_UOA_BASE_URL,
    'UOA_BASE_URL',
    !production,
  )
  const actorIssuer = normalizeOrigin(
    envValue(env, 'NESSIE_API_PUBLIC_URL') ?? 'http://localhost:5454',
    'NESSIE_API_PUBLIC_URL',
    !production,
  )
  const adminUrl = normalizeOrigin(
    envValue(env, 'NESSIE_ADMIN_PUBLIC_URL') ?? DEFAULT_ADMIN_URL,
    'NESSIE_ADMIN_PUBLIC_URL',
    !production,
  )
  const actor = parsePrivateActorKey(privateJwk)
  return {
    actorAudience: `${baseUrl}/billing/v1/effective-tariff`,
    actorIssuer,
    actorKey: actor.key,
    actorKeyId: actor.keyId,
    adminUrl,
    appKey,
    baseUrl,
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const signBillingActor = (
  settings: BillingSettings,
  subject: {
    organizationId: string
    teamId: string
    userId: string
  },
  nowSeconds: number,
  jti: string,
): string => {
  const header = encodeJson({
    alg: 'RS256',
    kid: settings.actorKeyId,
    typ: 'JWT',
  })
  const payload = encodeJson({
    iss: settings.actorIssuer,
    aud: settings.actorAudience,
    sub: subject.userId,
    product: NESSIE_PRODUCT,
    organisation_id: subject.organizationId,
    team_id: subject.teamId,
    iat: nowSeconds,
    exp: nowSeconds + BILLING_ACTOR_TTL_SECONDS,
    jti,
  })
  const signingInput = `${header}.${payload}`
  const signature = signBytes(
    'RSA-SHA256',
    Buffer.from(signingInput),
    settings.actorKey,
  ).toString('base64url')
  return `${signingInput}.${signature}`
}

type BillingAction = 'checkout' | 'portal' | 'summary'
type BillingSubject = {
  organizationId: string
  teamId: string
  userId: string
}

const actionRequest = (
  action: BillingAction,
  settings: BillingSettings,
  subject: BillingSubject,
): { body: Record<string, string>; path: string } => {
  const body = {
    product: NESSIE_PRODUCT,
    organisation_id: subject.organizationId,
    team_id: subject.teamId,
    user_id: subject.userId,
  }
  switch (action) {
    case 'checkout':
      return {
        body: {
          ...body,
          success_url: `${settings.adminUrl}/tokens?billing=success`,
          cancel_url: `${settings.adminUrl}/tokens?billing=cancelled`,
        },
        path: '/billing/v1/stripe/checkout-session',
      }
    case 'portal':
      return {
        body: { ...body, return_url: `${settings.adminUrl}/tokens` },
        path: '/billing/v1/stripe/portal-session',
      }
    case 'summary':
      return {
        body,
        path: '/billing/v1/stripe/subscription-summary',
      }
  }
}

const mapWorkspaceError = (error: BillingWorkspaceError): never => {
  throw new UoaBillingSubscriptionError(
    error.code === 'BILLING_CONTEXT_MISMATCH'
      ? 'UOA_BILLING_CONTEXT_MISMATCH'
      : 'UOA_BILLING_SSO_REQUIRED',
    error.message,
    error.code === 'BILLING_CONTEXT_MISMATCH' ? 409 : 403,
  )
}

const executeBillingAction = async (
  prisma: BillingWorkspacePrisma,
  actorContext: AuthorizedActionContext,
  action: BillingAction,
  deps: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    now?: () => number
    randomId?: () => string
  } = {},
): Promise<{ data: unknown; subject: BillingSubject }> => {
  const settings = loadBillingSettings(deps.env ?? process.env)
  let workspace: Awaited<ReturnType<typeof resolveBillingWorkspace>>
  try {
    workspace = await resolveBillingWorkspace(prisma, actorContext)
  } catch (error) {
    if (error instanceof BillingWorkspaceError) return mapWorkspaceError(error)
    throw error
  }
  const subject = {
    organizationId: workspace.identity.organizationId,
    teamId: workspace.identity.teamId,
    userId: workspace.identity.subject,
  }
  const nowSeconds = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const actor = signBillingActor(
    settings,
    subject,
    nowSeconds,
    deps.randomId?.() ?? randomUUID(),
  )
  const request = actionRequest(action, settings, subject)

  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(
      new URL(request.path, settings.baseUrl),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
          'X-UOA-Actor': actor,
          'X-UOA-App-Key': settings.appKey,
        },
        body: JSON.stringify(request.body),
      },
    )
  } catch {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_UPSTREAM_REJECTED',
      'UnlikeOtherAI billing is temporarily unavailable.',
      502,
    )
  }
  if (!response.ok) {
    const forbidden = response.status === 401 || response.status === 403
    const safeStatus = forbidden
      ? 403
      : [400, 409, 503].includes(response.status)
        ? response.status
        : 502
    throw new UoaBillingSubscriptionError(
      forbidden ? 'UOA_BILLING_FORBIDDEN' : 'UOA_BILLING_UPSTREAM_REJECTED',
      forbidden
        ? 'UnlikeOtherAI rejected this billing action.'
        : `UnlikeOtherAI billing rejected the request with status ${response.status}.`,
      safeStatus,
    )
  }
  try {
    return { data: await response.json(), subject }
  } catch {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_RESPONSE_INVALID',
      'UnlikeOtherAI billing returned a non-JSON response.',
      502,
    )
  }
}

const validateSummary = (
  value: unknown,
  subject: BillingSubject,
): UoaBillingSubscriptionSummary => {
  const parsed = UoaBillingSubscriptionSummarySchema.safeParse(value)
  if (
    !parsed.success
    || parsed.data.subject.user_id !== subject.userId
    || parsed.data.subject.organisation_id !== subject.organizationId
    || parsed.data.subject.team_id !== subject.teamId
  ) {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_RESPONSE_INVALID',
      'UnlikeOtherAI billing returned an invalid subscription response.',
      502,
    )
  }
  return parsed.data
}

export const getUoaBillingSubscription = async (
  prisma: BillingSubscriptionPrisma,
  actorContext: AuthorizedActionContext,
  deps?: Parameters<typeof executeBillingAction>[3],
): Promise<UoaBillingSubscriptionSummary> => {
  const response = await executeBillingAction(
    prisma,
    actorContext,
    'summary',
    deps,
  )
  return validateSummary(response.data, response.subject)
}

export const createUoaBillingCheckout = async (
  prisma: BillingSubscriptionPrisma,
  actorContext: AuthorizedActionContext,
  deps?: Parameters<typeof executeBillingAction>[3],
): Promise<UoaBillingCheckoutResponse> => {
  const response = await executeBillingAction(
    prisma,
    actorContext,
    'checkout',
    deps,
  )
  const result = UoaBillingCheckoutResponseSchema.safeParse(
    response.data,
  )
  if (!result.success) {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_RESPONSE_INVALID',
      'UnlikeOtherAI billing returned an invalid Checkout response.',
      502,
    )
  }
  return result.data
}

export const createUoaBillingPortal = async (
  prisma: BillingSubscriptionPrisma,
  actorContext: AuthorizedActionContext,
  deps?: Parameters<typeof executeBillingAction>[3],
): Promise<UoaBillingPortalResponse> => {
  const response = await executeBillingAction(
    prisma,
    actorContext,
    'portal',
    deps,
  )
  const result = UoaBillingPortalResponseSchema.safeParse(
    response.data,
  )
  if (!result.success) {
    throw new UoaBillingSubscriptionError(
      'UOA_BILLING_RESPONSE_INVALID',
      'UnlikeOtherAI billing returned an invalid portal response.',
      502,
    )
  }
  return result.data
}
