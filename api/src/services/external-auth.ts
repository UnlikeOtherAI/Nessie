import type { AuthProviderConfig } from '@nessie/config'
import { safeFetch, type SafeFetchOptions } from '@nessie/runtime'

import type { SsoTheme } from '../contracts/auth.js'
import {
  resolveIdentityDisplayName,
  type ExternalAuthIdentity,
} from './identity-display.js'
import {
  exchangeUoaSession,
  type UoaSessionExchange,
} from './uoa-session.js'
import { buildUoaAuthorizeUrl } from './uoa-auth.js'

type OidcDiscoveryDocument = {
  authorization_endpoint?: string
  jwks_uri?: string
  token_endpoint?: string
  userinfo_endpoint?: string
}

type TokenResponse = {
  access_token?: string
}

type UserInfoResponse = {
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  preferred_username?: string
  sub?: string
}

export type ExternalAuthExchangeResult = {
  identity: ExternalAuthIdentity
  uoaSession?: UoaSessionExchange
}

const normalizeIssuerUrl = (issuerUrl: string): string => issuerUrl.replace(/\/$/, '')

const buildDiscoveryUrl = (issuerUrl: string): string =>
  `${normalizeIssuerUrl(issuerUrl)}/.well-known/openid-configuration`

const ensureOidcProvider = (provider: AuthProviderConfig): void => {
  if (!provider.issuerUrl || !provider.clientId) {
    throw new Error('Provider is missing issuerUrl or clientId')
  }

  if (!['custom', 'oidc', 'uoa'].includes(provider.type)) {
    throw new Error(`Unsupported provider type: ${provider.type}`)
  }
}

// OIDC login egress is pinned end to end: the discovery URL and every endpoint
// the discovery document hands back are validated and dialed through safeFetch
// with no redirect following, so an IdP (or its discovery document) cannot
// bounce the code exchange or userinfo read onto another origin.
// The options are injectable so tests can stub DNS resolution at this seam.
const oidcFetchOptions = (options?: SafeFetchOptions): SafeFetchOptions => ({
  ...options,
  maxRedirects: 0,
})

/**
 * An endpoint the discovery document names is only ever dialed by this client,
 * so it must live on the issuer's own origin — anything else is either a
 * misconfiguration or an attempt to bounce the code/token exchange elsewhere.
 */
const ensureIssuerOriginEndpoint = (
  issuerUrl: string,
  endpointName: string,
  endpointUrl: string,
  providerId: string,
): void => {
  const issuerOrigin = new URL(normalizeIssuerUrl(issuerUrl)).origin
  let endpointOrigin: string
  try {
    endpointOrigin = new URL(endpointUrl).origin
  } catch {
    throw new Error(
      `Provider ${providerId} discovery document returned an invalid ${endpointName}`,
    )
  }
  if (endpointOrigin !== issuerOrigin) {
    throw new Error(
      `Provider ${providerId} discovery document ${endpointName} must share the issuer origin ${issuerOrigin} (got ${endpointOrigin})`,
    )
  }
}

const loadDiscoveryDocument = async (
  provider: AuthProviderConfig,
  options?: SafeFetchOptions,
): Promise<OidcDiscoveryDocument> => {
  ensureOidcProvider(provider)

  const response = await safeFetch(
    buildDiscoveryUrl(provider.issuerUrl!),
    undefined,
    oidcFetchOptions(options),
  )
  if (!response.ok) {
    throw new Error(`Failed to load discovery document for provider ${provider.providerId}`)
  }

  const discovery = (await response.json()) as OidcDiscoveryDocument
  const issuerUrl = provider.issuerUrl!
  for (const [name, endpoint] of [
    ['authorization_endpoint', discovery.authorization_endpoint],
    ['jwks_uri', discovery.jwks_uri],
    ['token_endpoint', discovery.token_endpoint],
    ['userinfo_endpoint', discovery.userinfo_endpoint],
  ] as const) {
    if (endpoint) ensureIssuerOriginEndpoint(issuerUrl, name, endpoint, provider.providerId)
  }
  return discovery
}

const resolveScopes = (provider: AuthProviderConfig): string =>
  provider.scopes.length > 0 ? provider.scopes.join(' ') : 'openid profile email'

export const buildExternalAuthAuthorizeUrl = async (
  provider: AuthProviderConfig,
  input: {
    codeChallenge: string
    redirectUri: string
    state: string
    teamHint?: string
    theme?: SsoTheme
  },
  options?: SafeFetchOptions,
): Promise<string> => {
  if (provider.type === 'uoa') {
    return buildUoaAuthorizeUrl(input)
  }

  const discovery = await loadDiscoveryDocument(provider, options)
  if (!discovery.authorization_endpoint) {
    throw new Error(`Provider ${provider.providerId} does not expose an authorization endpoint`)
  }

  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set('client_id', provider.clientId!)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', resolveScopes(provider))
  url.searchParams.set('state', input.state)
  return url.toString()
}

export const exchangeExternalAuthCode = async (
  provider: AuthProviderConfig,
  input: {
    code: string
    codeVerifier: string
    redirectUri: string
    theme?: SsoTheme
  },
  options?: SafeFetchOptions,
): Promise<ExternalAuthExchangeResult> => {
  if (provider.type === 'uoa') {
    const uoaSession = await exchangeUoaSession(input, options)
    return { identity: uoaSession.identity, uoaSession }
  }

  const discovery = await loadDiscoveryDocument(provider, options)
  if (!discovery.token_endpoint || !discovery.userinfo_endpoint) {
    throw new Error(`Provider ${provider.providerId} is missing token or userinfo endpoints`)
  }

  const tokenResponse = await safeFetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: provider.clientId!,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }),
  }, oidcFetchOptions(options))

  if (!tokenResponse.ok) {
    throw new Error(`Provider ${provider.providerId} rejected the authorization code`)
  }

  const tokenPayload = (await tokenResponse.json()) as TokenResponse
  if (!tokenPayload.access_token) {
    throw new Error(`Provider ${provider.providerId} did not return an access token`)
  }

  const userInfoResponse = await safeFetch(discovery.userinfo_endpoint, {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
    },
  }, oidcFetchOptions(options))

  if (!userInfoResponse.ok) {
    throw new Error(`Provider ${provider.providerId} did not return user information`)
  }

  const userInfo = (await userInfoResponse.json()) as UserInfoResponse
  // Accounts are linked and provisioned by email, so an IdP that hands back an
  // address it has itself marked unverified would let anyone who can assert an
  // email take over the matching Nessie account. Providers that omit the claim
  // are trusted as before; only an explicit `false` is rejected.
  if (userInfo.email_verified === false) {
    throw new Error(`Provider ${provider.providerId} returned an unverified email address`)
  }
  const email = userInfo.email?.trim().toLowerCase()
  if (!email) {
    throw new Error(`Provider ${provider.providerId} did not return an email address`)
  }

  return {
    identity: {
      avatarUrl: userInfo.picture,
      displayName: resolveIdentityDisplayName(email, [
        userInfo.name,
        userInfo.preferred_username,
      ]),
      email,
    },
  }
}
