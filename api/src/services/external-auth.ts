import type { AuthProviderConfig } from '@nessie/config'

import type { SsoTheme } from '../contracts/auth.js'
import {
  resolveIdentityDisplayName,
  type ExternalAuthIdentity,
} from './identity-display.js'
import { buildUoaAuthorizeUrl, exchangeUoaCode } from './uoa-auth.js'

type OidcDiscoveryDocument = {
  authorization_endpoint?: string
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

const loadDiscoveryDocument = async (
  provider: AuthProviderConfig,
): Promise<OidcDiscoveryDocument> => {
  ensureOidcProvider(provider)

  const response = await fetch(buildDiscoveryUrl(provider.issuerUrl!))
  if (!response.ok) {
    throw new Error(`Failed to load discovery document for provider ${provider.providerId}`)
  }

  return (await response.json()) as OidcDiscoveryDocument
}

const resolveScopes = (provider: AuthProviderConfig): string =>
  provider.scopes.length > 0 ? provider.scopes.join(' ') : 'openid profile email'

export const buildExternalAuthAuthorizeUrl = async (
  provider: AuthProviderConfig,
  input: {
    codeChallenge: string
    redirectUri: string
    state: string
    theme?: SsoTheme
  },
): Promise<string> => {
  if (provider.type === 'uoa') {
    return buildUoaAuthorizeUrl(input)
  }

  const discovery = await loadDiscoveryDocument(provider)
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
  },
): Promise<ExternalAuthIdentity> => {
  if (provider.type === 'uoa') {
    return exchangeUoaCode(input)
  }

  const discovery = await loadDiscoveryDocument(provider)
  if (!discovery.token_endpoint || !discovery.userinfo_endpoint) {
    throw new Error(`Provider ${provider.providerId} is missing token or userinfo endpoints`)
  }

  const tokenResponse = await fetch(discovery.token_endpoint, {
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
  })

  if (!tokenResponse.ok) {
    throw new Error(`Provider ${provider.providerId} rejected the authorization code`)
  }

  const tokenPayload = (await tokenResponse.json()) as TokenResponse
  if (!tokenPayload.access_token) {
    throw new Error(`Provider ${provider.providerId} did not return an access token`)
  }

  const userInfoResponse = await fetch(discovery.userinfo_endpoint, {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
    },
  })

  if (!userInfoResponse.ok) {
    throw new Error(`Provider ${provider.providerId} did not return user information`)
  }

  const userInfo = (await userInfoResponse.json()) as UserInfoResponse
  const email = userInfo.email?.trim().toLowerCase()
  if (!email) {
    throw new Error(`Provider ${provider.providerId} did not return an email address`)
  }

  return {
    avatarUrl: userInfo.picture,
    displayName: resolveIdentityDisplayName(email, [
      userInfo.name,
      userInfo.preferred_username,
    ]),
    email,
  }
}
