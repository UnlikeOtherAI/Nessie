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

import { SlackClient } from './client.js'
import {
  slackConnect,
  slackDisconnect,
  slackRefreshCredentials,
} from './oauth.js'
import { fetchAllConversations, toResource } from './resources.js'
import { runSlackSweep } from './sync.js'
import type { SlackConnectorDeps, SlackWebhookOutcome } from './types.js'
import { inspectSlackWebhook } from './webhook.js'

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_AFTER_CAP_MS = 60_000

/**
 * The Slack adapter's public shape: the provider-agnostic
 * {@link CommunicationsConnector} plus one Slack-specific extension,
 * {@link SlackConnector.inspectWebhook}, so the API layer can answer the
 * `url_verification` challenge — a case the shared `processWebhook` signature
 * (which only returns events) cannot express.
 */
export type SlackConnector = CommunicationsConnector & {
  inspectWebhook(request: WebhookRequest): SlackWebhookOutcome
}

/**
 * Build a personal-mode (user-token OAuth) Slack {@link CommunicationsConnector}.
 * All configuration and side-effect seams (`fetch`, `sleep`, clock) are injected
 * — the package reads no environment and talks only to `https://slack.com/api/*`.
 */
export const createSlackConnector = (
  deps: SlackConnectorDeps,
): SlackConnector => {
  const now = deps.now ?? (() => Date.now())
  const client = new SlackClient({
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    maxRetries: deps.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryAfterCapMs: deps.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS,
  })

  return {
    provider: 'slack',

    connect: (input: OAuthCallbackInput): Promise<ConnectResult> =>
      slackConnect(client, deps, input, now()),

    refreshCredentials: (
      connection: ConnectorConnectionContext,
    ): Promise<CredentialBundle> =>
      slackRefreshCredentials(client, deps, connection, now()),

    discoverResources: async (
      connection: ConnectorConnectionContext,
    ): Promise<Resource[]> => {
      const conversations = await fetchAllConversations(
        client,
        connection.credential.accessToken,
      )
      return conversations.map(toResource)
    },

    runInitialSync: (
      connection: ConnectorConnectionContext,
      checkpoint?: SyncCheckpoint,
    ): Promise<SyncResult> =>
      runSlackSweep(client, connection, checkpoint ?? {}, 'history'),

    runIncrementalSync: (
      connection: ConnectorConnectionContext,
      checkpoint: SyncCheckpoint,
    ): Promise<SyncResult> =>
      runSlackSweep(client, connection, checkpoint, 'incremental'),

    processWebhook: (request: WebhookRequest): Promise<NormalizedEvent[]> => {
      const outcome = inspectSlackWebhook(request, deps.signingSecret, now())
      return Promise.resolve(outcome.kind === 'events' ? outcome.events : [])
    },

    inspectWebhook: (request: WebhookRequest): SlackWebhookOutcome =>
      inspectSlackWebhook(request, deps.signingSecret, now()),

    // Slack's HTTPS Events API needs no watch renewal — subscriptions live in
    // the app's Event Subscriptions config, not per-connection watches.
    renewSubscriptions: (): Promise<SubscriptionDescriptor[]> =>
      Promise.resolve([]),

    disconnect: (connection: ConnectorConnectionContext): Promise<void> =>
      slackDisconnect(client, connection),
  }
}
