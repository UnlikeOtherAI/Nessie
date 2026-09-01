import type { NormalizedEvent } from './events.js'

/**
 * A resumable position inside a provider's history/delta stream. `cursor` is
 * the opaque provider pagination or delta token persisted on the sync job so a
 * failed run resumes instead of restarting. The imported-window bounds let the
 * connector page backwards (history) and forwards (incremental) deterministically.
 */
export type SyncCheckpoint = {
  cursor?: string
  oldestImportedAt?: string
  newestImportedAt?: string
}

/**
 * A discoverable container inside a connection: a Slack channel/DM/group,
 * a Teams chat or team channel, a Gmail label, an Outlook folder, etc.
 * `resourceType` is free-form so each provider names its own kinds.
 */
export type Resource = {
  resourceType: string
  externalId: string
  name?: string
  visibility?: string
  userHasAccess: boolean
  syncEnabled?: boolean
}

/**
 * A webhook/watch subscription the connector created and that must be renewed
 * before {@link expiresAt}. Persisted as a `CommsSubscription` row.
 */
export type SubscriptionDescriptor = {
  externalSubscriptionId: string
  resourceExternalId?: string
  clientState?: string
  expiresAt: string
}

/**
 * The result of one sync page. The worker persists {@link events} idempotently,
 * writes {@link checkpoint} back to the sync job, and continues while
 * {@link hasMore} is true. A connector may surface freshly-created
 * {@link subscriptions} that the worker records for renewal.
 */
export type SyncResult = {
  events: NormalizedEvent[]
  checkpoint: SyncCheckpoint
  hasMore: boolean
  subscriptions?: SubscriptionDescriptor[]
}
