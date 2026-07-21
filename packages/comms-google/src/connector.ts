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

import { GmailClient } from './client.js'
import {
  DEFAULT_OFF_LABELS,
  nowMs,
  resolveScopes,
  type GoogleConnectorDeps,
} from './config.js'
import { GmailReauthorizationRequiredError } from './errors.js'
import { GMAIL_VISIBILITY } from './normalize.js'
import { decodePubSubNotification } from './pubsub.js'
import { runGmailInitialSync, runGmailIncrementalSync } from './sync.js'

const MAILBOX_LABEL_RESOURCE = 'mailbox_label'

const parseScopeString = (scope: string | undefined, fallback: string[]): string[] => {
  if (!scope) {
    return fallback
  }
  const parsed = scope.split(/\s+/).filter((entry) => entry.length > 0)
  return parsed.length > 0 ? parsed : fallback
}

const expiresAtIso = (
  deps: GoogleConnectorDeps,
  expiresIn: number | undefined,
): string | undefined =>
  expiresIn !== undefined
    ? new Date(nowMs(deps) + expiresIn * 1000).toISOString()
    : undefined

const readCodeVerifier = (statePayload: Record<string, unknown>): string | undefined => {
  const value = statePayload.codeVerifier
  return typeof value === 'string' ? value : undefined
}

/**
 * The Gmail personal-mailbox adapter. Implements the shared
 * {@link CommunicationsConnector} contract over the fixed Google OAuth + Gmail
 * REST endpoints via an injected {@link GoogleConnectorDeps}. A personal mailbox
 * is its own tenant: both `externalUserId` and `externalTenantId` are the
 * account's email address.
 */
export const createGoogleConnector = (
  deps: GoogleConnectorDeps,
): CommunicationsConnector => {
  const client = new GmailClient({
    fetchImpl: deps.fetch,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
  })

  const connect = async (input: OAuthCallbackInput): Promise<ConnectResult> => {
    const token = await client.exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: readCodeVerifier(input.statePayload),
    })
    const profile = await client.getProfile(token.access_token)
    const scopes = parseScopeString(token.scope, resolveScopes(deps))
    return {
      externalTenantId: profile.emailAddress,
      externalUserId: profile.emailAddress,
      credential: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtIso(deps, token.expires_in),
        scopes,
      },
      grantedScopes: scopes,
    }
  }

  const refreshCredentials = async (
    connection: ConnectorConnectionContext,
  ): Promise<CredentialBundle> => {
    const { refreshToken } = connection.credential
    if (!refreshToken) {
      throw new GmailReauthorizationRequiredError('no refresh token stored')
    }
    const token = await client.refresh(refreshToken)
    const scopes = parseScopeString(token.scope, connection.credential.scopes)
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? refreshToken,
      expiresAt: expiresAtIso(deps, token.expires_in),
      scopes,
    }
  }

  const discoverResources = async (
    connection: ConnectorConnectionContext,
  ): Promise<Resource[]> => {
    const labels = await client.listLabels(connection.credential.accessToken)
    return labels.map((label) => ({
      resourceType: MAILBOX_LABEL_RESOURCE,
      externalId: label.id,
      name: label.name,
      visibility: GMAIL_VISIBILITY,
      userHasAccess: true,
      syncEnabled: !DEFAULT_OFF_LABELS.has(label.id),
    }))
  }

  const runInitialSync = (
    connection: ConnectorConnectionContext,
    checkpoint?: SyncCheckpoint,
  ): Promise<SyncResult> =>
    runGmailInitialSync(client, deps, connection, checkpoint)

  const runIncrementalSync = (
    connection: ConnectorConnectionContext,
    checkpoint: SyncCheckpoint,
  ): Promise<SyncResult> =>
    runGmailIncrementalSync(client, deps, connection, checkpoint)

  /**
   * A Gmail Pub/Sub push only says "the mailbox changed". We validate the
   * envelope decodes and return no events; the API decodes the same payload
   * with {@link decodePubSubNotification} to match the connection and enqueue an
   * incremental sync, which fetches the actual changes.
   */
  const processWebhook = async (
    request: WebhookRequest,
  ): Promise<NormalizedEvent[]> => {
    decodePubSubNotification(request)
    return []
  }

  const renewSubscriptions = async (
    connection: ConnectorConnectionContext,
  ): Promise<SubscriptionDescriptor[]> => {
    const watch = await client.watch(connection.credential.accessToken, {
      topicName: deps.pubsubTopic,
    })
    const expiresAt = watch.expiration
      ? new Date(Number(watch.expiration)).toISOString()
      : new Date(nowMs(deps)).toISOString()
    return [
      {
        externalSubscriptionId: `gmail-watch:${connection.externalUserId}`,
        clientState: watch.historyId,
        expiresAt,
      },
    ]
  }

  const disconnect = async (
    connection: ConnectorConnectionContext,
  ): Promise<void> => {
    const { accessToken, refreshToken } = connection.credential
    try {
      await client.stop(accessToken)
    } catch {
      // Best-effort: ending the watch must not block disconnection.
    }
    try {
      await client.revoke(refreshToken ?? accessToken)
    } catch {
      // Tolerate an already-revoked/invalid token during disconnect.
    }
  }

  return {
    provider: 'google',
    connect,
    refreshCredentials,
    discoverResources,
    runInitialSync,
    runIncrementalSync,
    processWebhook,
    renewSubscriptions,
    disconnect,
  }
}
