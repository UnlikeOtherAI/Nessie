import crypto from 'node:crypto'

import type { ExternalAuthIdentity } from './external-auth.js'

/**
 * UnlikeOtherAuthenticator (UOA) integration — the config-JWT auto-onboarding
 * flow documented at https://authentication.unlikeotherai.com/llm and `/api`.
 *
 * UOA is not standard OIDC (no `/.well-known/openid-configuration`). A relying
 * party authenticates by:
 *   1. Publishing a JWKS at `https://<domain>/.well-known/jwks.json`.
 *   2. Serving a `config_url` that returns an RS256-signed config JWT describing
 *      the integration (domain, redirect_urls, auth methods, theme).
 *   3. Sending the browser to `GET <base>/auth?config_url=…&redirect_url=…&
 *      code_challenge=…&code_challenge_method=S256`. UOA renders the login UI;
 *      on first contact with a new domain it raises an integration request that
 *      a UOA superuser approves, after which a one-time `client_secret` is
 *      claimed.
 *   4. Exchanging the returned `code` server-to-server at `POST <base>/auth/token`
 *      authenticated with `Bearer <client_hash>` where
 *      `client_hash = SHA256(domain + client_secret)`. The response carries an
 *      HS256 access token whose claims (`sub`, `email`) identify the user; per
 *      UOA's contract the RP does not verify it cryptographically (trust derives
 *      from the authenticated backend channel).
 */

export type UoaSettings = {
  baseUrl: string
  domain: string
  configUrl: string
  jwksUrl: string
  redirectUrl: string
  contactEmail: string
  privateKeyPem: string
  kid: string
  clientSecret: string
}

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`[uoa] ${name} is not set`)
  }
  return value
}

/**
 * Load UOA settings from the environment. The private key is provided base64 to
 * keep the PEM on a single line (docker compose env_file cannot carry multiline
 * values). `UOA_CLIENT_SECRET` may be empty until the integration is approved —
 * the authorize step (onboarding) does not need it; only token exchange does.
 */
export const loadUoaSettings = (): UoaSettings => ({
  baseUrl: (process.env.UOA_BASE_URL ?? 'https://authentication.unlikeotherai.com').replace(/\/$/, ''),
  domain: requireEnv('UOA_DOMAIN'),
  configUrl: requireEnv('UOA_CONFIG_URL'),
  jwksUrl: requireEnv('UOA_JWKS_URL'),
  redirectUrl: requireEnv('UOA_REDIRECT_URL'),
  contactEmail: process.env.UOA_CONTACT_EMAIL ?? '',
  privateKeyPem: Buffer.from(requireEnv('UOA_CONFIG_JWT_PRIVATE_KEY_B64'), 'base64').toString('utf8'),
  kid: requireEnv('UOA_CONFIG_JWT_KID'),
  clientSecret: process.env.UOA_CLIENT_SECRET ?? '',
})

export const isUoaConfigured = (): boolean => {
  try {
    loadUoaSettings()
    return true
  } catch {
    return false
  }
}

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Minimal but schema-complete UI theme. UOA requires the `colors`, `radii`,
 * `density`, `typography`, `button`, `card`, and `logo` sections to be present.
 */
const defaultUiTheme = (settings: UoaSettings): Record<string, unknown> => ({
  colors: {
    primary: '#7c3aed',
    bg: '#1a1024',
    surface: '#241634',
    text: '#f5f3ff',
    primary_text: '#f5f3ff',
    muted: '#a78bfa',
    border: '#3b2a52',
    danger: '#ef4444',
    danger_text: '#ffffff',
  },
  radii: { card: '16px', button: '10px', input: '8px' },
  density: 'comfortable',
  typography: { font_family: 'Inter, system-ui, sans-serif', base_text_size: 'md' },
  button: { style: 'solid' },
  card: { style: 'shadow' },
  logo: { url: `https://${settings.domain}/icon.png`, alt: 'Nessie' },
})

/**
 * Build and sign the config JWT served at the `config_url`. `jwks_url` and
 * `contact_email` are always included so the first call against a new domain
 * triggers UOA auto-discovery / onboarding.
 */
export const buildConfigJwt = (settings: UoaSettings): string => {
  const header = base64UrlJson({ alg: 'RS256', kid: settings.kid, typ: 'JWT' })
  const payload = base64UrlJson({
    domain: settings.domain,
    redirect_urls: [settings.redirectUrl],
    enabled_auth_methods: ['email_password', 'google'],
    language_config: 'en',
    ui_theme: defaultUiTheme(settings),
    jwks_url: settings.jwksUrl,
    contact_email: settings.contactEmail,
  })
  const signingInput = `${header}.${payload}`
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput), settings.privateKeyPem)
    .toString('base64url')
  return `${signingInput}.${signature}`
}

/** Public JWK derived from the configured private key, for the JWKS endpoint. */
export const buildPublicJwks = (settings: UoaSettings): { keys: Record<string, unknown>[] } => {
  const jwk = crypto
    .createPublicKey(settings.privateKeyPem)
    .export({ format: 'jwk' }) as Record<string, unknown>
  return {
    keys: [{ ...jwk, kid: settings.kid, alg: 'RS256', use: 'sig' }],
  }
}

/** SHA256(domain + clientSecret) hex — UOA's bearer credential for token exchange. */
const clientHash = (settings: UoaSettings): string =>
  crypto.createHash('sha256').update(settings.domain + settings.clientSecret).digest('hex')

/**
 * Build the UOA authorization URL. The config-JWT flow identifies the client via
 * `config_url` (not a client_id) and carries no `state` — PKCE protects the
 * exchange and the RP keeps its own CSRF token in sessionStorage.
 */
export const buildUoaAuthorizeUrl = (input: {
  codeChallenge: string
  redirectUri: string
}): string => {
  const settings = loadUoaSettings()
  const url = new URL(`${settings.baseUrl}/auth`)
  url.searchParams.set('config_url', settings.configUrl)
  url.searchParams.set('redirect_url', input.redirectUri)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

type UoaTokenResponse = { access_token?: string }

const decodeJwtClaims = (token: string): Record<string, unknown> => {
  const segment = token.split('.')[1]
  if (!segment) {
    throw new Error('[uoa] access token is not a JWT')
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

/**
 * Exchange the authorization code for tokens and resolve the user identity from
 * the access-token claims.
 */
export const exchangeUoaCode = async (input: {
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<ExternalAuthIdentity> => {
  const settings = loadUoaSettings()
  if (!settings.clientSecret) {
    throw new Error('[uoa] UOA_CLIENT_SECRET is not set — approve the integration and configure the secret')
  }

  const tokenUrl = new URL(`${settings.baseUrl}/auth/token`)
  tokenUrl.searchParams.set('config_url', settings.configUrl)

  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${clientHash(settings)}`,
    },
    body: JSON.stringify({
      code: input.code,
      redirect_url: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  })
  if (!response.ok) {
    throw new Error(`[uoa] token endpoint returned ${response.status}`)
  }

  const payload = (await response.json()) as UoaTokenResponse
  if (!payload.access_token) {
    throw new Error('[uoa] token response missing access_token')
  }

  const claims = decodeJwtClaims(payload.access_token)
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (!email) {
    throw new Error('[uoa] access token did not carry an email claim')
  }
  const name = typeof claims.name === 'string' && claims.name.trim().length > 0
    ? claims.name.trim()
    : email

  return { displayName: name, email }
}
