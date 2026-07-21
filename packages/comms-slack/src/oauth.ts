import type {
  ConnectResult,
  ConnectorConnectionContext,
  CredentialBundle,
  OAuthCallbackInput,
} from '@nessie/comms-connect'

import { SlackApiError, type SlackClient } from './client.js'
import type { SlackConnectorDeps } from './types.js'

type AuthedUser = {
  id?: string
  scope?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

type OAuthAccessResponse = {
  ok: boolean
  error?: string
  team?: { id?: string }
  authed_user?: AuthedUser
  // Present on a `grant_type=refresh_token` rotation response.
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

type AuthTestResponse = {
  ok: boolean
  error?: string
  user_id?: string
  team_id?: string
}

const splitScopes = (scope: string | undefined): string[] =>
  (scope ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const expiryFromSeconds = (
  nowMs: number,
  expiresIn: number | undefined,
): string | undefined =>
  typeof expiresIn === 'number' && expiresIn > 0
    ? new Date(nowMs + expiresIn * 1000).toISOString()
    : undefined

/**
 * Exchange the OAuth authorization code for a **user** token bundle via
 * `oauth.v2.access`, reading the `authed_user.*` fields (not the bot token), and
 * confirm the identity with `auth.test`. Returns the durable
 * {@link ConnectResult} the connection row + credential store persist.
 */
export const slackConnect = async (
  client: SlackClient,
  deps: SlackConnectorDeps,
  input: OAuthCallbackInput,
  nowMs: number,
): Promise<ConnectResult> => {
  const access = await client.call<OAuthAccessResponse>({
    method: 'oauth.v2.access',
    params: {
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri || deps.redirectUri,
    },
  })

  const authedUser = access.authed_user ?? {}
  const accessToken = authedUser.access_token
  if (!accessToken) {
    throw new SlackApiError({ code: 'missing_user_token', retryable: false })
  }
  const scopes = splitScopes(authedUser.scope)
  const credential: CredentialBundle = {
    accessToken,
    refreshToken: authedUser.refresh_token,
    expiresAt: expiryFromSeconds(nowMs, authedUser.expires_in),
    scopes,
  }

  const identity = await client.call<AuthTestResponse>({
    method: 'auth.test',
    token: accessToken,
  })

  return {
    externalTenantId: identity.team_id ?? access.team?.id ?? '',
    externalUserId: identity.user_id ?? authedUser.id ?? '',
    credential,
    grantedScopes: scopes,
  }
}

/**
 * Refresh a rotation-enabled Slack user token via
 * `oauth.v2.access` with `grant_type=refresh_token`. Tolerates non-rotating
 * grants: with no stored refresh token the current bundle is returned unchanged.
 */
export const slackRefreshCredentials = async (
  client: SlackClient,
  deps: SlackConnectorDeps,
  connection: ConnectorConnectionContext,
  nowMs: number,
): Promise<CredentialBundle> => {
  const { credential } = connection
  if (!credential.refreshToken) {
    return credential
  }

  const refreshed = await client.call<OAuthAccessResponse>({
    method: 'oauth.v2.access',
    params: {
      client_id: deps.clientId,
      client_secret: deps.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    },
  })

  const accessToken = refreshed.access_token ?? refreshed.authed_user?.access_token
  if (!accessToken) {
    // Slack accepted the call but returned no new token: keep the old bundle.
    return credential
  }
  const expiresIn = refreshed.expires_in ?? refreshed.authed_user?.expires_in
  const scope = refreshed.scope ?? refreshed.authed_user?.scope
  return {
    accessToken,
    refreshToken:
      refreshed.refresh_token
      ?? refreshed.authed_user?.refresh_token
      ?? credential.refreshToken,
    expiresAt: expiryFromSeconds(nowMs, expiresIn),
    scopes: scope ? splitScopes(scope) : credential.scopes,
  }
}

/**
 * Revoke the user token with `auth.revoke`. An already-revoked/expired token is
 * treated as success — disconnect must be idempotent.
 */
export const slackDisconnect = async (
  client: SlackClient,
  connection: ConnectorConnectionContext,
): Promise<void> => {
  try {
    await client.call({
      method: 'auth.revoke',
      token: connection.credential.accessToken,
    })
  } catch (error) {
    if (error instanceof SlackApiError && error.needsReauthorization) {
      return
    }
    throw error
  }
}
