import { createHash, randomBytes } from 'node:crypto'

import type { FastifyRequest } from 'fastify'
import type { CommsProvider } from '@nessie/schemas'

/**
 * Server-side OAuth *start* configuration for the Individual Communications
 * Connector. This owns only what is needed to build the provider authorization
 * (redirect) URL — endpoint, requested scopes, and the client id resolved from
 * deployment env. The code→token exchange (and any client secret) lives in the
 * provider adapter's `connect()` inside `@nessie/comms-connect`; this module
 * never sees a secret.
 *
 * Microsoft is intentionally absent: its `/start` returns 501 until the Graph
 * adapter lands.
 */
export type CommsOAuthProviderConfig = {
  authorizeEndpoint: string
  /** Slack puts *user* token scopes in `user_scope`; OAuth2 core uses `scope`. */
  scopeParam: 'scope' | 'user_scope'
  scopes: string[]
  usePkce: boolean
  /** Static extra query params (e.g. Google offline access + consent prompt). */
  extraParams: Record<string, string>
  /** Env var holding the public OAuth client id for this provider. */
  clientIdEnv: string
}

const COMMS_OAUTH_CONFIG: Partial<Record<CommsProvider, CommsOAuthProviderConfig>> = {
  slack: {
    authorizeEndpoint: 'https://slack.com/oauth/v2/authorize',
    scopeParam: 'user_scope',
    scopes: [
      'channels:history',
      'channels:read',
      'groups:history',
      'groups:read',
      'im:history',
      'im:read',
      'mpim:history',
      'mpim:read',
      'users:read',
      'search:read',
    ],
    usePkce: false,
    extraParams: {},
    clientIdEnv: 'NESSIE_COMMS_SLACK_CLIENT_ID',
  },
  google: {
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopeParam: 'scope',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'openid',
      'email',
      'profile',
    ],
    usePkce: true,
    extraParams: {
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
    },
    clientIdEnv: 'NESSIE_COMMS_GOOGLE_CLIENT_ID',
  },
}

export const getCommsOAuthConfig = (
  provider: CommsProvider,
): CommsOAuthProviderConfig | undefined => COMMS_OAUTH_CONFIG[provider]

/** A generated PKCE pair; the verifier is persisted in the OAuth state row. */
export type PkcePair = { codeVerifier: string; codeChallenge: string }

export const generatePkcePair = (): PkcePair => {
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  return { codeVerifier, codeChallenge }
}

/** A cryptographically-random, single-use OAuth `state` token. */
export const generateOAuthStateToken = (): string =>
  randomBytes(32).toString('base64url')

/**
 * Build the callback URL the provider redirects back to. Prefer the configured
 * public API origin (stable behind a proxy); fall back to the inbound
 * request's forwarded proto/host so local dev works without extra config.
 */
export const buildCommsCallbackUrl = (
  request: FastifyRequest,
  provider: CommsProvider,
  apiPublicUrl?: string,
): string => {
  const path = `/api/comms/connections/${provider}/callback`
  if (apiPublicUrl) {
    return `${apiPublicUrl.replace(/\/$/, '')}${path}`
  }
  const protoHeader = request.headers['x-forwarded-proto']
  const proto = typeof protoHeader === 'string'
    ? protoHeader.split(',')[0]?.trim() ?? request.protocol
    : request.protocol
  const hostHeader = request.headers['x-forwarded-host'] ?? request.headers.host
  const host = typeof hostHeader === 'string'
    ? hostHeader.split(',')[0]?.trim()
    : undefined
  return host ? `${proto}://${host}${path}` : path
}

export type BuildAuthorizeUrlInput = {
  config: CommsOAuthProviderConfig
  clientId: string
  redirectUri: string
  state: string
  codeChallenge?: string
}

export const buildAuthorizeUrl = (input: BuildAuthorizeUrlInput): string => {
  const { config, clientId, redirectUri, state, codeChallenge } = input
  const url = new URL(config.authorizeEndpoint)
  const params = url.searchParams
  params.set('client_id', clientId)
  params.set('redirect_uri', redirectUri)
  params.set('state', state)
  params.set(config.scopeParam, config.scopes.join(' '))
  for (const [key, value] of Object.entries(config.extraParams)) {
    params.set(key, value)
  }
  if (config.usePkce && codeChallenge) {
    params.set('code_challenge', codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  return url.toString()
}
