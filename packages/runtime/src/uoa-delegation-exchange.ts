import crypto from 'node:crypto'

/**
 * The one UOA call behind every delegated identity: exchanging Nessie's signed
 * subject assertion for a short-lived `X-UOA-Delegation` token at UOA's
 * `/auth/token` (RFC 8693 token exchange), and what a failed exchange says.
 *
 * A failure is classified, not just thrown, because callers must act on what
 * it means rather than on the fact that it failed: UOA refusing the person
 * (their credential epoch moved, or they lost the organisation, team or domain
 * role) is an identity change the person has to fix by signing in again; UOA
 * not answering, or answering 408/429/5xx, passes; and a refused client, an
 * unverifiable assertion or an answer outside the contract is a deployment
 * fault no person can fix. Retrying the first or the last in a loop is the
 * failure mode this classification exists to prevent.
 */

const NESSIE_PRODUCT = 'nessie'
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

/** What went wrong with one exchange. */
export type UoaExchangeFailure =
  /** UOA answered with this non-2xx status. */
  | { kind: 'refused'; status: number }
  /** No answer at all: the request never completed. */
  | { kind: 'unreachable' }
  /** A 2xx answer with no usable token. */
  | { kind: 'malformed' }
  /** UOA issued a token for another credential epoch than the one asserted. */
  | { kind: 'epoch_mismatch' }

export class UoaDelegatedIdentityError extends Error {
  constructor(
    public readonly code:
      | 'UOA_IDENTITY_REQUIRED'
      | 'UOA_ACTIVE_TEAM_REQUIRED'
      | 'UOA_TOKEN_EXCHANGE_FAILED',
    message: string,
    /** Set on every `UOA_TOKEN_EXCHANGE_FAILED`: what the exchange failed with. */
    public readonly exchangeFailure: UoaExchangeFailure | null = null,
  ) {
    super(message)
    this.name = 'UoaDelegatedIdentityError'
  }
}

/**
 * What a failed exchange means for the person it was for.
 *
 * - `identity`: UOA refused *this person* — 403 is how UOA's token exchange
 *   answers an epoch that moved, a lost domain role, or an organisation or team
 *   they no longer belong to (it keeps which one opaque) — or it issued a token
 *   for another epoch. Only the person signing in again fixes it.
 * - `transient`: no answer, or 408, 429 or a 5xx. The same exchange can
 *   succeed shortly.
 * - `fault`: any other refusal (400 bad request or config, 401 client or
 *   assertion not verified), or a 2xx outside the contract. Nothing the person
 *   does fixes it and repeating it changes nothing.
 */
export const classifyUoaExchangeFailure = (
  failure: UoaExchangeFailure | null,
): 'identity' | 'transient' | 'fault' => {
  if (failure === null) return 'fault'
  switch (failure.kind) {
    case 'epoch_mismatch':
      return 'identity'
    case 'unreachable':
      return 'transient'
    case 'malformed':
      return 'fault'
    case 'refused':
      if (failure.status === 403) return 'identity'
      if (failure.status === 408 || failure.status === 429 || failure.status >= 500) return 'transient'
      return 'fault'
  }
}

const exchangeFailed = (message: string, failure: UoaExchangeFailure): UoaDelegatedIdentityError =>
  new UoaDelegatedIdentityError('UOA_TOKEN_EXCHANGE_FAILED', message, failure)

const decodeJwtClaims = (token: string): Record<string, unknown> | null => {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? claims as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

const decodeJwtExpiry = (token: string, fallback: number): number => {
  const exp = decodeJwtClaims(token)?.exp
  return typeof exp === 'number' ? exp : fallback
}

const decodeJwtTokenVersion = (token: string): number | undefined => {
  const claims = decodeJwtClaims(token)
  if (!claims) {
    throw exchangeFailed('UOA delegation exchange returned an invalid access token.', { kind: 'malformed' })
  }
  if (claims.tv === undefined) return undefined
  if (typeof claims.tv !== 'number' || !Number.isSafeInteger(claims.tv) || claims.tv < 0) {
    throw exchangeFailed('UOA delegation exchange returned an invalid access token.', { kind: 'malformed' })
  }
  return claims.tv
}

/**
 * The request function the exchange dials through, injected by the identity
 * service that owns the transport choice (`createUoaDelegatedIdentityService`).
 */
export type UoaExchangeFetch = (url: URL, init: RequestInit) => Promise<Response>

export type UoaDelegationExchangeSettings = {
  authBaseUrl: string
  clientSecret: string
  configUrl: string
  sourceDomain: string
}

/**
 * Exchange a signed subject assertion for a delegation token bound to
 * `tokenVersion`. Returns the token and its expiry in epoch seconds; throws a
 * classified `UOA_TOKEN_EXCHANGE_FAILED` otherwise.
 */
export const exchangeUoaDelegation = async (
  settings: UoaDelegationExchangeSettings,
  fetchImpl: UoaExchangeFetch,
  input: {
    subjectToken: string
    scope: 'ai.invoke' | 'billing.read'
    audience: string
    tokenVersion: number
    nowSeconds: number
    fallbackTtlSeconds: number
  },
): Promise<{ token: string; expiresAt: number }> => {
  const clientHash = crypto
    .createHash('sha256')
    .update(settings.sourceDomain + settings.clientSecret)
    .digest('hex')
  const exchangeUrl = new URL(`${settings.authBaseUrl}/auth/token`)
  exchangeUrl.searchParams.set('config_url', settings.configUrl)
  let response: Response
  try {
    response = await fetchImpl(exchangeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientHash}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: TOKEN_EXCHANGE_GRANT,
        product: NESSIE_PRODUCT,
        scope: input.scope,
        subject_token_type: JWT_TOKEN_TYPE,
        resource: input.audience,
        subject_token: input.subjectToken,
      }),
    })
  } catch (error) {
    throw exchangeFailed(
      `UOA delegation exchange did not answer: ${error instanceof Error ? error.message : String(error)}`,
      { kind: 'unreachable' },
    )
  }
  if (!response.ok) {
    throw exchangeFailed(
      `UOA delegation exchange failed with status ${response.status}.`,
      { kind: 'refused', status: response.status },
    )
  }
  let body: { access_token?: unknown; expires_in?: unknown }
  try {
    body = await response.json() as typeof body
  } catch {
    throw exchangeFailed('UOA delegation exchange answered without a JSON body.', { kind: 'malformed' })
  }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw exchangeFailed('UOA delegation exchange returned no access token.', { kind: 'malformed' })
  }
  const returnedTokenVersion = decodeJwtTokenVersion(body.access_token)
  if (returnedTokenVersion === undefined) {
    // A token that names no epoch cannot be bound to this session: UOA broke
    // its contract, which is not the person's doing.
    throw exchangeFailed('UOA delegation exchange returned an access token with no credential epoch.', {
      kind: 'malformed',
    })
  }
  if (returnedTokenVersion !== input.tokenVersion) {
    throw exchangeFailed(
      'UOA delegation exchange returned an access token for a different credential epoch.',
      { kind: 'epoch_mismatch' },
    )
  }
  const fallbackExpiry = input.nowSeconds
    + (typeof body.expires_in === 'number' ? body.expires_in : input.fallbackTtlSeconds)
  return { token: body.access_token, expiresAt: decodeJwtExpiry(body.access_token, fallbackExpiry) }
}
