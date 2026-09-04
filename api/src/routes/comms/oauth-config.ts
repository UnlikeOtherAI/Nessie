import { createHash, randomBytes } from 'node:crypto'

import type { FastifyRequest } from 'fastify'
import type { CommsProvider } from '@nessie/schemas'

import { resolvePublicOrigin } from '../../lib/public-origin.js'

/**
 * Server-side OAuth *start* configuration for the Individual Communications
 * Connector. This owns only what is needed to build the provider authorization
 * (redirect) URL — endpoint, requested scopes, and the client id resolved from
 * deployment env. The code→token exchange (and any client secret) lives in the
 * provider adapter's `connect()` inside `@nessie/comms-connect`; this module
 * never sees a secret.
 *
 */
export type CommsOAuthProviderConfig = {
  authorizeEndpoint: string
  /** Slack puts *user* token scopes in `user_scope`; OAuth2 core uses `scope`. */
  scopeParam: 'scope' | 'user_scope'
  scopes: string[]
  usePkce: boolean
  /** Bind an OIDC id_token to this server-authored authorization transaction. */
  useNonce?: boolean
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
      'https://www.googleapis.com/auth/meetings.space.created',
      'openid',
      'email',
      'profile',
    ],
    usePkce: true,
    // `prompt` is deliberately absent: it is decided per request by
    // `forceConsent`, because forcing a re-prompt on every incremental scope
    // add is a visible cost and is not what re-issues a refresh token.
    extraParams: {
      response_type: 'code',
      access_type: 'offline',
      include_granted_scopes: 'true',
    },
    clientIdEnv: 'NESSIE_COMMS_GOOGLE_CLIENT_ID',
  },
  microsoft: {
    // `/common` supports both Microsoft consumer and organisational accounts.
    // The connector validates the Graph-proven account plus its v2 tenant
    // claims before any connection is persisted.
    authorizeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scopeParam: 'scope',
    scopes: [
      // Mail.Read supplies message body/bodyPreview for the CommsEvent store.
      // Mail.Send / Mail.ReadWrite are intentionally absent: this connector
      // contract owns import, not outbound mail or mailbox mutation.
      'Mail.Read',
      // Graph `/me` is the account authority after code exchange.
      'User.Read',
      'openid',
      'profile',
      'email',
      'offline_access',
    ],
    usePkce: true,
    useNonce: true,
    extraParams: { response_type: 'code' },
    clientIdEnv: 'NESSIE_COMMS_MICROSOFT_CLIENT_ID',
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

/** A server-held OIDC nonce, distinct from OAuth state and the PKCE verifier. */
export const generateOAuthNonce = (): string => randomBytes(32).toString('base64url')

/**
 * Build the callback URL the provider redirects back to. The origin comes
 * from `resolvePublicOrigin`: the configured `api.publicUrl`, or — local
 * mode only — Fastify's trust-proxy-scoped protocol/hostname. Raw
 * X-Forwarded-* / Host headers are never consulted, and a hosted/selfHosted
 * deployment without `api.publicUrl` fails loudly instead of trusting the
 * request.
 */
export const buildCommsCallbackUrl = (
  request: FastifyRequest,
  provider: CommsProvider,
  config: Parameters<typeof resolvePublicOrigin>[1],
): string =>
  `${resolvePublicOrigin(request, config)}/api/comms/connections/${provider}/callback`

export type BuildAuthorizeUrlInput = {
  config: CommsOAuthProviderConfig
  clientId: string
  redirectUri: string
  state: string
  codeChallenge?: string
  nonce?: string
  /**
   * The exact scopes to request. Overrides the provider's static list, which
   * remains the default for providers with no capability catalog. Google is
   * driven from `@nessie/schemas` `scopesForCapabilities`.
   */
  scopes?: readonly string[]
  /**
   * Ask Google to re-prompt. Required when a refresh token must be re-issued
   * (a first connect); NOT required merely because an incremental scope is
   * new, and a re-prompt is a visible cost to the person, so callers opt in.
   */
  forceConsent?: boolean
  /**
   * Pre-select the account being re-authorized, so adding a scope to one of
   * two linked accounts does not silently land on the other. Advisory only:
   * the callback still verifies which account came back.
   */
  loginHint?: string
}

export const buildAuthorizeUrl = (input: BuildAuthorizeUrlInput): string => {
  const { config, clientId, redirectUri, state, codeChallenge } = input
  const url = new URL(config.authorizeEndpoint)
  const params = url.searchParams
  params.set('client_id', clientId)
  params.set('redirect_uri', redirectUri)
  params.set('state', state)
  const scopes = input.scopes && input.scopes.length > 0
    ? input.scopes
    : config.scopes
  params.set(config.scopeParam, scopes.join(' '))
  for (const [key, value] of Object.entries(config.extraParams)) {
    params.set(key, value)
  }
  if (input.forceConsent) {
    params.set('prompt', 'consent')
  }
  if (input.loginHint) {
    params.set('login_hint', input.loginHint)
  }
  if (config.usePkce && codeChallenge) {
    params.set('code_challenge', codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  if (config.useNonce && input.nonce) {
    params.set('nonce', input.nonce)
  }
  return url.toString()
}
