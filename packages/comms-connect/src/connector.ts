import type { NormalizedEvent } from './events.js'
import type { CommsProviderId } from './provider.js'
import type {
  Resource,
  SubscriptionDescriptor,
  SyncCheckpoint,
  SyncResult,
} from './sync.js'
import type { WebhookRequest } from './webhook.js'

/**
 * Decrypted OAuth token material a connector needs to call a provider. The
 * worker resolves this from the encrypted `CommsConnectionCredential` row via
 * the shared secret-crypto seam; the plaintext never leaves the server.
 */
export type CredentialBundle = {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scopes: string[]
}

/**
 * The view of a connection a connector operates on. Combines the persisted
 * `CommsConnection` identity with the freshly-decrypted {@link CredentialBundle}
 * so provider adapters never touch Prisma or the secret store directly.
 */
export type ConnectorConnectionContext = {
  id: string
  organizationId: string
  ownerUserId: string
  provider: CommsProviderId
  externalTenantId: string
  externalUserId: string
  credential: CredentialBundle
}

/** Input to {@link CommunicationsConnector.connect} — the OAuth callback. */
export type OAuthCallbackInput = {
  organizationId: string
  userId: string
  provider: CommsProviderId
  code: string
  redirectUri: string
  /** Server-side state row payload (PKCE verifier, nonce, …), already validated. */
  statePayload: Record<string, unknown>
}

/**
 * The outcome of a successful connect: the provider tenant/user identity to
 * persist on the `CommsConnection`, the token bundle to encrypt, and the
 * granted scopes.
 */
export type ConnectResult = {
  externalTenantId: string
  externalUserId: string
  credential: CredentialBundle
  grantedScopes: string[]
  /**
   * The provider's stable, immutable account id, when it exposes one distinct
   * from the human-readable `externalUserId`. Google's OIDC `sub` is the case
   * this exists for: an email address can be renamed, so re-authorizing an
   * existing connection compares this instead to prove the same account came
   * back.
   */
  providerAccountId?: string
}

/**
 * The provider-agnostic contract every communications adapter (Slack, Google,
 * Microsoft) implements. Strictly the connector layer: authentication,
 * retrieval, sync, normalization, and subscription lifecycle — no business
 * intelligence and no coupling to the Chief-of-Staff reasoning layer.
 */
export interface CommunicationsConnector {
  readonly provider: CommsProviderId

  /**
   * Opt into the worker's generic delta reconciliation sweep. Providers with
   * webhooks leave this unset; a positive interval asks for a bounded poll at
   * most once per interval, without adding provider branches to the worker.
   */
  readonly incrementalPollingIntervalMs?: number

  /** Exchange an OAuth callback for durable credentials + provider identity. */
  connect(input: OAuthCallbackInput): Promise<ConnectResult>

  /** Refresh an expired/expiring access token, returning the new bundle. */
  refreshCredentials(
    connection: ConnectorConnectionContext,
  ): Promise<CredentialBundle>

  /** Enumerate the channels/chats/labels/folders the user can sync. */
  discoverResources(
    connection: ConnectorConnectionContext,
  ): Promise<Resource[]>

  /** Import one page of historical messages, resuming from `checkpoint`. */
  runInitialSync(
    connection: ConnectorConnectionContext,
    checkpoint?: SyncCheckpoint,
  ): Promise<SyncResult>

  /** Import one page of new/changed messages since `checkpoint`. */
  runIncrementalSync(
    connection: ConnectorConnectionContext,
    checkpoint: SyncCheckpoint,
  ): Promise<SyncResult>

  /** Turn a raw webhook delivery into normalized events (idempotent). */
  processWebhook(request: WebhookRequest): Promise<NormalizedEvent[]>

  /** Renew this connection's watch subscriptions before they expire. */
  renewSubscriptions(
    connection: ConnectorConnectionContext,
  ): Promise<SubscriptionDescriptor[]>

  /** Revoke provider-side access; imported data deletion is the caller's job. */
  disconnect(connection: ConnectorConnectionContext): Promise<void>
}
