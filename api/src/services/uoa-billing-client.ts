import {
  createPrivateKey,
  randomUUID,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto'
import type { AuthorizedActionContext } from '@nessie/schemas'
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
  appKey: string
  baseUrl: string
}

export type UoaBillingSubject = {
  organizationId: string
  teamId: string
  userId: string
}

export type UoaBillingClientDeps = {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
  randomId?: () => string
}

export type UoaBillingClient = {
  post: (
    path: string,
    body: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>
  subject: UoaBillingSubject
}

export class UoaBillingError extends Error {
  constructor(
    public readonly code:
      | 'UOA_BILLING_ACTION_INVALID'
      | 'UOA_BILLING_ACTION_UNAVAILABLE'
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
    this.name = 'UoaBillingError'
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
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error('invalid')
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new UoaBillingError(
      'UOA_BILLING_UNCONFIGURED',
      `${name} must be a credential-free ${allowHttp ? 'HTTP(S)' : 'HTTPS'} origin.`,
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
    throw new UoaBillingError(
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
    throw new UoaBillingError(
      'UOA_BILLING_UNCONFIGURED',
      `Billing requires ${NESSIE_UOA_BILLING_APP_KEY_ENV} and ${NESSIE_UOA_BILLING_ACTOR_KEY_ENV}.`,
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
  const actor = parsePrivateActorKey(privateJwk)
  return {
    actorAudience: `${baseUrl}/billing/v1/effective-tariff`,
    actorIssuer,
    actorKey: actor.key,
    actorKeyId: actor.keyId,
    appKey,
    baseUrl,
  }
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

const signBillingActor = (
  settings: BillingSettings,
  subject: UoaBillingSubject,
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

const mapWorkspaceError = (error: BillingWorkspaceError): never => {
  throw new UoaBillingError(
    error.code === 'BILLING_CONTEXT_MISMATCH'
      ? 'UOA_BILLING_CONTEXT_MISMATCH'
      : 'UOA_BILLING_SSO_REQUIRED',
    error.message,
    error.code === 'BILLING_CONTEXT_MISMATCH' ? 409 : 403,
  )
}

const billingUrl = (settings: BillingSettings, path: string): URL => {
  const url = new URL(path, `${settings.baseUrl}/`)
  if (
    !path.startsWith('/billing/v1/')
    || url.origin !== settings.baseUrl
    || url.pathname !== path
    || url.search
    || url.hash
  ) {
    throw new UoaBillingError(
      'UOA_BILLING_ACTION_INVALID',
      'UnlikeOtherAI returned an invalid billing action.',
      502,
    )
  }
  return url
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    throw new UoaBillingError(
      'UOA_BILLING_RESPONSE_INVALID',
      'UnlikeOtherAI billing returned a non-JSON response.',
      502,
    )
  }
}

export const createUoaBillingClient = async (
  prisma: BillingWorkspacePrisma,
  actorContext: AuthorizedActionContext,
  deps: UoaBillingClientDeps = {},
): Promise<UoaBillingClient> => {
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
  return {
    subject,
    post: async (path, body) => {
      const nowSeconds = deps.now?.() ?? Math.floor(Date.now() / 1000)
      const actor = signBillingActor(
        settings,
        subject,
        nowSeconds,
        deps.randomId?.() ?? randomUUID(),
      )
      let response: Response
      try {
        response = await (deps.fetchImpl ?? fetch)(
          billingUrl(settings, path),
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json',
              'X-UOA-Actor': actor,
              'X-UOA-App-Key': settings.appKey,
            },
            body: JSON.stringify(body),
          },
        )
      } catch (error) {
        if (error instanceof UoaBillingError) throw error
        throw new UoaBillingError(
          'UOA_BILLING_UPSTREAM_REJECTED',
          'UnlikeOtherAI billing is temporarily unavailable.',
          502,
        )
      }
      if (!response.ok) {
        const forbidden = response.status === 401 || response.status === 403
        const safeStatus = forbidden
          ? 403
          : [400, 404, 409, 410, 422, 503].includes(response.status)
            ? response.status
            : 502
        throw new UoaBillingError(
          forbidden
            ? 'UOA_BILLING_FORBIDDEN'
            : 'UOA_BILLING_UPSTREAM_REJECTED',
          forbidden
            ? 'UnlikeOtherAI rejected this billing action.'
            : `UnlikeOtherAI billing rejected the request with status ${response.status}.`,
          safeStatus,
        )
      }
      return readJson(response)
    },
  }
}

