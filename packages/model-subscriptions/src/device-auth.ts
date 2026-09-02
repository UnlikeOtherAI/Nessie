import { createHash, randomBytes } from 'node:crypto'
import { safeFetch } from '@nessie/runtime'
import {
  ModelSubscriptionError,
  SUBSCRIPTION_ERROR_CODES,
  type SubscriptionAccountIdentity,
  type SubscriptionCredentialBundle,
} from './types.js'

/**
 * Device-code linking: Nessie's OWN grant, run entirely server-side.
 *
 * Two reasons this is the primary flow rather than a browser redirect. It needs
 * no loopback listener, so a person on the web app is served exactly as well as
 * one on the desktop; and the token exchange never touches the browser, so a
 * credential cannot be read out of a page. The person sees a short code and a
 * link, and completes consent on any device.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.5.
 */

export type DeviceAuthorizationStart = {
  /** Shown to the person; entered at `verificationUri`. */
  userCode: string
  verificationUri: string
  /** Pre-filled variant when the provider offers one. */
  verificationUriComplete?: string
  /** Opaque per-provider state the poll needs. Server-side only. */
  pollState: Record<string, unknown>
  expiresAt: number
  intervalMs: number
}

export type DeviceAuthorizationPoll =
  | { status: 'pending'; intervalMs: number }
  | { status: 'ready'; bundle: SubscriptionCredentialBundle; identity: SubscriptionAccountIdentity }
  | { status: 'denied'; reason: string }
  | { status: 'expired' }

export type DeviceAuthorizationFlow = {
  start: () => Promise<DeviceAuthorizationStart>
  poll: (pollState: Record<string, unknown>) => Promise<DeviceAuthorizationPoll>
}

const MIN_INTERVAL_MS = 1_000
const DEFAULT_INTERVAL_MS = 5_000
const SLOW_DOWN_INCREMENT_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const request = async (
  url: string,
  init: { body: string; contentType: string; headers?: Record<string, string> },
): Promise<{ body: Record<string, unknown>; ok: boolean; status: number }> => {
  let response: Response
  try {
    response = await safeFetch(
      url,
      {
        body: init.body,
        headers: {
          Accept: 'application/json',
          'Content-Type': init.contentType,
          ...(init.headers ?? {}),
        },
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      { credentialsPresent: true, maxRedirects: 0 },
    )
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'The provider could not be reached. Try again in a moment.',
    )
  }
  return { body: await readJson(response), ok: response.ok, status: response.status }
}

/**
 * Read the account identity out of an OIDC id_token.
 *
 * Deliberately strict about the claims that decide WHO this credential belongs
 * to — issuer, audience, expiry, and a stable subject — because relink refuses
 * a different account and that refusal is only as good as this reading. The
 * signature is not verified here: the token arrived over a pinned TLS channel
 * directly from the issuer's own token endpoint in response to our own request,
 * so there is no third party to have forged it. It is used for display and
 * account-matching only, never as an authorization decision.
 */
export const readIdTokenIdentity = (
  idToken: string,
  expected: { audience: string; issuer: string },
): SubscriptionAccountIdentity => {
  const parts = idToken.split('.')
  const payloadPart = parts[1]
  if (parts.length !== 3 || !payloadPart) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'The provider returned an identity token this deployment could not read.',
    )
  }
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'The provider returned an identity token this deployment could not read.',
    )
  }

  const issuer = str(claims.iss)
  const audience = Array.isArray(claims.aud)
    ? claims.aud.map((value) => str(value)).filter(Boolean)
    : [str(claims.aud)].filter(Boolean)
  const subject = str(claims.sub)
  const expiry = typeof claims.exp === 'number' ? claims.exp : undefined

  const issuerMatches = issuer !== undefined
    && (issuer === expected.issuer || issuer === `${expected.issuer}/`)
  if (!issuerMatches || !audience.includes(expected.audience) || !subject) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'The provider returned an identity for a different application.',
    )
  }
  if (expiry !== undefined && expiry * 1000 < Date.now()) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'The provider returned an expired identity token.',
    )
  }

  const label = str(claims.email) ?? str(claims.preferred_username) ?? str(claims.name)
  return {
    ...(label ? { accountLabel: label } : {}),
    providerAccountId: subject,
  }
}

/**
 * Refuse a grant that came back without a refresh token.
 *
 * Without one the link would work until the first access token expired and then
 * silently die, which is a worse outcome than refusing at the point where the
 * person can still do something about it.
 */
const requireBundle = (
  body: Record<string, unknown>,
  provider: string,
): SubscriptionCredentialBundle => {
  const accessToken = str(body.access_token)
  const refreshToken = str(body.refresh_token)
  if (!accessToken) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `${provider} did not return an access token.`,
    )
  }
  if (!refreshToken) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `${provider} did not return a refresh token, so this link could not be kept alive.`,
    )
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
  return {
    accessToken,
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    refreshToken,
    ...(str(body.scope) ? { scope: str(body.scope) as string } : {}),
    ...(str(body.id_token) ? { idToken: str(body.id_token) as string } : {}),
    ...(str(body.token_type) ? { tokenType: str(body.token_type) as string } : {}),
  }
}

const readInterval = (value: unknown): number => {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return Math.max(seconds ? seconds * 1000 : DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS)
}

// ─── OpenAI Codex ────────────────────────────────────────────────────────────

export const OPENAI_AUTH_BASE_URL = 'https://auth.openai.com'
/**
 * The Codex client. It is the vendor's own public client id, and Nessie
 * identifies itself alongside it with `originator` rather than pretending to be
 * the CLI. Pinned in code, never configured.
 */
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_CODEX_SCOPES = 'openid profile email offline_access'
const OPENAI_CODEX_CALLBACK = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`
const OPENAI_DEVICE_TTL_MS = 15 * 60_000

const openaiHeaders = (contentType: string): Record<string, string> => ({
  'Content-Type': contentType,
  originator: 'nessie',
  'User-Agent': 'nessie',
})

export const createCodexDeviceFlow = (): DeviceAuthorizationFlow => ({
  poll: async (pollState) => {
    const deviceAuthId = str(pollState.deviceAuthId)
    const userCode = str(pollState.userCode)
    if (!deviceAuthId || !userCode) return { status: 'expired' }

    const claimed = await request(
      `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
      {
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        contentType: 'application/json',
        headers: openaiHeaders('application/json'),
      },
    )
    if (!claimed.ok) {
      // OpenAI answers a not-yet-approved code with a 4xx rather than an
      // `authorization_pending` body, so anything short of a server fault is
      // treated as "still waiting" until the state row's own deadline passes.
      if (claimed.status >= 500) {
        throw new ModelSubscriptionError(
          SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
          'OpenAI could not complete the sign-in right now.',
        )
      }
      return { intervalMs: DEFAULT_INTERVAL_MS, status: 'pending' }
    }

    const authorizationCode = str(claimed.body.authorization_code)
    const codeVerifier = str(claimed.body.code_verifier)
    if (!authorizationCode || !codeVerifier) {
      return { intervalMs: DEFAULT_INTERVAL_MS, status: 'pending' }
    }

    const exchanged = await request(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
      body: new URLSearchParams({
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: OPENAI_CODEX_CALLBACK,
      }).toString(),
      contentType: 'application/x-www-form-urlencoded',
      headers: openaiHeaders('application/x-www-form-urlencoded'),
    })
    if (!exchanged.ok) {
      return { reason: 'OpenAI refused the sign-in.', status: 'denied' }
    }

    const bundle = requireBundle(exchanged.body, 'OpenAI')
    const identity = bundle.idToken
      ? readIdTokenIdentity(bundle.idToken, {
        audience: OPENAI_CODEX_CLIENT_ID,
        issuer: OPENAI_AUTH_BASE_URL,
      })
      : { providerAccountId: fingerprint(bundle.refreshToken ?? bundle.accessToken) }
    return { bundle, identity, status: 'ready' }
  },

  start: async () => {
    const result = await request(
      `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
      {
        body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
        contentType: 'application/json',
        headers: openaiHeaders('application/json'),
      },
    )
    if (!result.ok) {
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
        result.status === 404
          ? 'OpenAI device sign-in is not available for this account type.'
          : 'OpenAI could not start the sign-in.',
      )
    }
    const deviceAuthId = str(result.body.device_auth_id)
    const userCode = str(result.body.user_code) ?? str(result.body.usercode)
    if (!deviceAuthId || !userCode) {
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
        'OpenAI returned an unreadable sign-in code.',
      )
    }
    return {
      expiresAt: Date.now() + OPENAI_DEVICE_TTL_MS,
      intervalMs: readInterval(result.body.interval),
      pollState: { deviceAuthId, userCode },
      userCode,
      verificationUri: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    }
  },
})

// ─── xAI Grok ────────────────────────────────────────────────────────────────

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_SCOPES =
  'openid profile email offline_access grok-cli:access api:access'
const XAI_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const XAI_DEVICE_TTL_MS = 15 * 60_000

/**
 * Every endpoint xAI's discovery document names must live on x.ai. Discovery is
 * fetched from a pinned issuer, but a compromised or mistaken document could
 * otherwise redirect the device grant — and the person's consent — somewhere
 * else entirely.
 */
const requireTrustedXaiEndpoint = (value: unknown, what: string): string => {
  const raw = str(value)
  let url: URL | undefined
  try {
    url = raw ? new URL(raw) : undefined
  } catch {
    url = undefined
  }
  const host = url?.hostname.toLowerCase()
  const trusted = url?.protocol === 'https:'
    && host !== undefined
    && (host === 'x.ai' || host.endsWith('.x.ai'))
  if (!url || !trusted) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      `xAI returned an untrusted ${what}.`,
    )
  }
  return url.toString()
}

const discoverXai = async (): Promise<{
  deviceAuthorizationEndpoint: string
  tokenEndpoint: string
}> => {
  let response: Response
  try {
    response = await safeFetch(
      `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`,
      { headers: { Accept: 'application/json' }, method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      { maxRedirects: 0 },
    )
  } catch {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'xAI could not be reached to start the sign-in.',
    )
  }
  if (!response.ok) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
      'xAI could not be reached to start the sign-in.',
    )
  }
  const body = await readJson(response)
  return {
    deviceAuthorizationEndpoint: requireTrustedXaiEndpoint(
      body.device_authorization_endpoint,
      'device authorization endpoint',
    ),
    tokenEndpoint: requireTrustedXaiEndpoint(body.token_endpoint, 'token endpoint'),
  }
}

export const createGrokDeviceFlow = (): DeviceAuthorizationFlow => ({
  poll: async (pollState) => {
    const deviceCode = str(pollState.deviceCode)
    const tokenEndpoint = str(pollState.tokenEndpoint)
    if (!deviceCode || !tokenEndpoint) return { status: 'expired' }

    const result = await request(requireTrustedXaiEndpoint(tokenEndpoint, 'token endpoint'), {
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: XAI_DEVICE_GRANT,
      }).toString(),
      contentType: 'application/x-www-form-urlencoded',
    })

    if (result.ok) {
      const bundle = requireBundle(result.body, 'xAI')
      const identity = bundle.idToken
        ? readIdTokenIdentity(bundle.idToken, {
          audience: XAI_OAUTH_CLIENT_ID,
          issuer: XAI_OAUTH_ISSUER,
        })
        : { providerAccountId: fingerprint(bundle.refreshToken ?? bundle.accessToken) }
      return { bundle, identity, status: 'ready' }
    }

    const error = str(result.body.error)
    if (error === 'authorization_pending') {
      return { intervalMs: DEFAULT_INTERVAL_MS, status: 'pending' }
    }
    if (error === 'slow_down') {
      return { intervalMs: DEFAULT_INTERVAL_MS + SLOW_DOWN_INCREMENT_MS, status: 'pending' }
    }
    if (error === 'expired_token') return { status: 'expired' }
    if (error === 'access_denied' || error === 'authorization_denied') {
      return { reason: 'The sign-in was declined.', status: 'denied' }
    }
    return {
      reason: 'xAI refused the sign-in. Check that your account has an eligible subscription.',
      status: 'denied',
    }
  },

  start: async () => {
    const { deviceAuthorizationEndpoint, tokenEndpoint } = await discoverXai()
    const result = await request(deviceAuthorizationEndpoint, {
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPES,
      }).toString(),
      contentType: 'application/x-www-form-urlencoded',
    })
    if (!result.ok) {
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
        'xAI could not start the sign-in.',
      )
    }
    const deviceCode = str(result.body.device_code)
    const userCode = str(result.body.user_code)
    const verificationUri = str(result.body.verification_uri)
    if (!deviceCode || !userCode || !verificationUri) {
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.VERIFY_FAILED,
        'xAI returned an unreadable sign-in code.',
      )
    }
    const complete = str(result.body.verification_uri_complete)
    const expiresIn = typeof result.body.expires_in === 'number'
      ? result.body.expires_in * 1000
      : XAI_DEVICE_TTL_MS
    return {
      expiresAt: Date.now() + expiresIn,
      intervalMs: readInterval(result.body.interval),
      pollState: { deviceCode, tokenEndpoint },
      userCode,
      verificationUri: requireTrustedXaiEndpoint(verificationUri, 'device verification URI'),
      ...(complete
        ? {
          verificationUriComplete: requireTrustedXaiEndpoint(
            complete,
            'complete device verification URI',
          ),
        }
        : {}),
    }
  },
})

const fingerprint = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)

/** Unguessable state token for a device-auth row. */
export const generateDeviceStateToken = (): string =>
  randomBytes(32).toString('base64url')
