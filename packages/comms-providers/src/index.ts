import {
  registerConnector,
  type CommsProviderId,
} from '@nessie/comms-connect'
import { createGoogleConnector } from '@nessie/comms-google'
import { createSlackConnector } from '@nessie/comms-slack'

/**
 * Startup bootstrap for the Individual Communications Connector registry.
 *
 * The shared `@nessie/comms-connect` registry is empty until an adapter is
 * registered, so nothing resolves at runtime. This package is the one place
 * that reads deployment env and wires the provider adapters into the registry,
 * used by BOTH the API (OAuth callback → `connect`) and the worker (sync jobs).
 *
 * The env var names are kept identical to the API's OAuth-start source of truth
 * (`api/src/routes/comms/oauth-config.ts`), which reads the same client ids to
 * build authorization URLs.
 */

/** Env var holding the Slack app OAuth client id (shared with oauth-config). */
export const SLACK_CLIENT_ID_ENV = 'NESSIE_COMMS_SLACK_CLIENT_ID'
/** Env var holding the Slack app OAuth client secret (token exchange). */
export const SLACK_CLIENT_SECRET_ENV = 'NESSIE_COMMS_SLACK_CLIENT_SECRET'
/** Env var holding the Slack Events API request-signing secret. */
export const SLACK_SIGNING_SECRET_ENV = 'NESSIE_COMMS_SLACK_SIGNING_SECRET'

/** Env var holding the Google OAuth client id (shared with oauth-config). */
export const GOOGLE_CLIENT_ID_ENV = 'NESSIE_COMMS_GOOGLE_CLIENT_ID'
/** Env var holding the Google OAuth client secret (token exchange). */
export const GOOGLE_CLIENT_SECRET_ENV = 'NESSIE_COMMS_GOOGLE_CLIENT_SECRET'
/** Optional fully-qualified Pub/Sub topic for Gmail `users.watch`. */
export const GOOGLE_PUBSUB_TOPIC_ENV = 'NESSIE_COMMS_GOOGLE_PUBSUB_TOPIC'

type Env = Record<string, string | undefined>

/**
 * Build and register every communications connector whose credentials are
 * present in `env`, returning the ids actually registered. A provider whose env
 * is unset is simply not registered — the sync worker already parks cleanly on
 * `ConnectorNotRegisteredError` — so this never throws on missing config.
 *
 * Register once per process at startup, in both the API and the worker.
 */
export const registerCommsConnectorsFromEnv = (
  env: Env,
): CommsProviderId[] => {
  const registered: CommsProviderId[] = []

  const slackClientId = env[SLACK_CLIENT_ID_ENV]
  const slackClientSecret = env[SLACK_CLIENT_SECRET_ENV]
  const slackSigningSecret = env[SLACK_SIGNING_SECRET_ENV]
  if (slackClientId && slackClientSecret && slackSigningSecret) {
    const slack = createSlackConnector({
      clientId: slackClientId,
      clientSecret: slackClientSecret,
      signingSecret: slackSigningSecret,
    })
    registerConnector('slack', () => slack)
    registered.push('slack')
  }

  const googleClientId = env[GOOGLE_CLIENT_ID_ENV]
  const googleClientSecret = env[GOOGLE_CLIENT_SECRET_ENV]
  if (googleClientId && googleClientSecret) {
    const google = createGoogleConnector({
      fetch,
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      pubsubTopic: env[GOOGLE_PUBSUB_TOPIC_ENV] ?? '',
    })
    registerConnector('google', () => google)
    registered.push('google')
  }

  return registered
}
