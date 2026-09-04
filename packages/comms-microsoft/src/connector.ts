import type {
  CommunicationsConnector,
  ConnectResult,
  ConnectorConnectionContext,
  CredentialBundle,
  NormalizedEvent,
  OAuthCallbackInput,
  Resource,
  SubscriptionDescriptor,
  SyncCheckpoint,
  SyncResult,
  WebhookRequest,
} from '@nessie/comms-connect'

import { MicrosoftGraphClient, type MicrosoftMailFolder } from './client.js'
import { nowMs, type MicrosoftConnectorDeps } from './config.js'
import {
  MicrosoftIdentityError,
  readMicrosoftAccountIdentity,
  readMicrosoftTokenIdentity,
} from './identity.js'
import { MicrosoftReauthorizationRequiredError } from './errors.js'
import { MICROSOFT_MAIL_VISIBILITY } from './normalize.js'
import { runMicrosoftIncrementalSync, runMicrosoftInitialSync } from './sync.js'

const MAIL_FOLDER_RESOURCE = 'mail_folder'
const DEFAULT_OFF_FOLDERS = new Set(['junkemail', 'deleteditems'])
const INCREMENTAL_POLL_INTERVAL_MS = 5 * 60 * 1000

const splitScopes = (value: string | undefined): string[] =>
  (value ?? '').split(/\s+/).filter((scope) => scope.length > 0)

const grantedScopes = (value: string | undefined): string[] => {
  const scopes = splitScopes(value)
  if (scopes.length === 0) {
    throw new MicrosoftIdentityError('the token response carried no granted scopes')
  }
  return scopes
}

const readCodeVerifier = (payload: Record<string, unknown>): string => {
  const verifier = payload.codeVerifier
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    throw new MicrosoftIdentityError('OAuth state carried no valid PKCE verifier')
  }
  return verifier
}

const readNonce = (payload: Record<string, unknown>): string => {
  const nonce = payload.nonce
  if (typeof nonce !== 'string' || nonce.length < 32 || nonce.length > 128) {
    throw new MicrosoftIdentityError('OAuth state carried no valid OIDC nonce')
  }
  return nonce
}

const expiry = (deps: MicrosoftConnectorDeps, seconds: number | undefined): string | undefined =>
  seconds === undefined ? undefined : new Date(nowMs(deps) + seconds * 1000).toISOString()

/** Microsoft identity + Graph mail adapter; no Teams or outbound mail surface. */
export const createMicrosoftConnector = (
  deps: MicrosoftConnectorDeps,
): CommunicationsConnector => {
  const client = new MicrosoftGraphClient({
    fetch: deps.fetch,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
  })

  const connect = async (input: OAuthCallbackInput): Promise<ConnectResult> => {
    const token = await client.exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: readCodeVerifier(input.statePayload),
    })
    if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
      throw new MicrosoftIdentityError('token response carried no access token')
    }
    const tokenIdentity = readMicrosoftTokenIdentity(
      token.id_token,
      deps.clientId,
      readNonce(input.statePayload),
      nowMs(deps),
    )
    // Graph /me proves which mailbox the returned access token can reach; no
    // e-mail address from a decoded token is used as connection authority.
    const identity = readMicrosoftAccountIdentity(
      tokenIdentity,
      await client.getMe(token.access_token),
    )
    const scopes = grantedScopes(token.scope)
    return {
      externalTenantId: identity.tenantId,
      externalUserId: identity.email,
      providerAccountId: identity.accountId,
      credential: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiry(deps, token.expires_in),
        scopes,
      },
      grantedScopes: scopes,
    }
  }

  const refreshCredentials = async (
    connection: ConnectorConnectionContext,
  ): Promise<CredentialBundle> => {
    if (!connection.credential.refreshToken) {
      throw new MicrosoftReauthorizationRequiredError('no refresh token stored')
    }
    const token = await client.refresh(connection.credential.refreshToken)
    if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
      throw new MicrosoftIdentityError('refresh response carried no access token')
    }
    const scopes = splitScopes(token.scope)
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? connection.credential.refreshToken,
      expiresAt: expiry(deps, token.expires_in),
      scopes: scopes.length > 0 ? scopes : connection.credential.scopes,
    }
  }

  const discoverResources = async (
    connection: ConnectorConnectionContext,
  ): Promise<Resource[]> => {
    const folders: MicrosoftMailFolder[] = []
    let pageUrl: string | undefined
    for (let pageCount = 0; pageCount < 20; pageCount += 1) {
      const page = await client.listMailFolders(connection.credential.accessToken, pageUrl)
      folders.push(...(page.value ?? []))
      pageUrl = page['@odata.nextLink']
      if (!pageUrl) break
    }
    if (pageUrl) {
      throw new Error('[comms-microsoft] Graph returned too many mail-folder pages')
    }
    return folders.flatMap((folder) => {
      if (typeof folder.id !== 'string' || folder.id.length === 0) return []
      const known = folder.wellKnownName?.toLowerCase()
      return [{
        resourceType: MAIL_FOLDER_RESOURCE,
        externalId: folder.id,
        name: folder.displayName ?? folder.id,
        visibility: MICROSOFT_MAIL_VISIBILITY,
        userHasAccess: true,
        syncEnabled: !DEFAULT_OFF_FOLDERS.has(known ?? ''),
      }]
    })
  }

  return {
    provider: 'microsoft',
    incrementalPollingIntervalMs: INCREMENTAL_POLL_INTERVAL_MS,
    connect,
    refreshCredentials,
    discoverResources,
    runInitialSync: (
      connection: ConnectorConnectionContext,
      checkpoint?: SyncCheckpoint,
    ): Promise<SyncResult> => runMicrosoftInitialSync(client, deps, connection, checkpoint),
    runIncrementalSync: (
      connection: ConnectorConnectionContext,
      checkpoint: SyncCheckpoint,
    ): Promise<SyncResult> => runMicrosoftIncrementalSync(client, deps, connection, checkpoint),
    // Graph webhook subscriptions are intentionally not created in this slice.
    processWebhook: (_request: WebhookRequest): Promise<NormalizedEvent[]> => Promise.resolve([]),
    renewSubscriptions: (): Promise<SubscriptionDescriptor[]> => Promise.resolve([]),
    // Microsoft v2 does not expose a delegated OAuth revocation endpoint. The
    // caller deletes local credentials; the person can revoke app consent from
    // Microsoft. Claiming a remote revoke here would be misleading.
    disconnect: (_connection: ConnectorConnectionContext): Promise<void> => Promise.resolve(),
  }
}
