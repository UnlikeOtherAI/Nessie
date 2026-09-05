import { z } from 'zod'

import {
  GoogleCapabilityIdSchema,
  GoogleCapabilityListSchema,
} from './google-capabilities.js'

/**
 * Queue topics for the Individual Communications Connector sync pipeline. The
 * worker registers a handler per topic; provider adapters plug into the shared
 * connector registry later. See
 * docs/plans/2026-07-21-individual-communications-connector.md.
 */
export const COMMS_SYNC_INITIAL_TOPIC = 'comms.sync.initial'
export const COMMS_SYNC_INCREMENTAL_TOPIC = 'comms.sync.incremental'
export const COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC = 'comms.sync.incremental-sweep'
export const COMMS_SUBSCRIPTIONS_RENEW_TOPIC = 'comms.subscriptions.renew'
export const COMMS_WEBHOOK_PROCESS_TOPIC = 'comms.webhook.process'

export const CommsProviderSchema = z.enum(['slack', 'google', 'microsoft'])
export type CommsProvider = z.infer<typeof CommsProviderSchema>

/**
 * `comms.sync.initial` — import historical messages for a connection. When
 * `resourceId` is set the job back-fills a single resource; otherwise it drives
 * whole-connection discovery + history. Resumable: the worker keeps the
 * provider cursor on the `CommsSyncJob` row so a retry continues instead of
 * restarting.
 */
export const CommsSyncInitialJobPayloadSchema = z.object({
  connectionId: z.string().uuid(),
  resourceId: z.string().uuid().optional(),
})
export type CommsSyncInitialJobPayload = z.infer<
  typeof CommsSyncInitialJobPayloadSchema
>

/**
 * `comms.sync.incremental` — pull new/changed messages since the connection's
 * (or resource's) last checkpoint.
 */
export const CommsSyncIncrementalJobPayloadSchema = z.object({
  connectionId: z.string().uuid(),
  resourceId: z.string().uuid().optional(),
})
export type CommsSyncIncrementalJobPayload = z.infer<
  typeof CommsSyncIncrementalJobPayloadSchema
>

/**
 * `comms.sync.incremental-sweep` — bounded reconciliation for connections
 * whose provider has no push notification subscription. The bucket is part of
 * the idempotency key, not a provider cursor or a user-facing timestamp.
 */
export const CommsIncrementalSweepJobPayloadSchema = z.object({
  provider: CommsProviderSchema,
  bucket: z.number().int().nonnegative(),
  /** Resume after this connection id when one bounded page is full. */
  afterId: z.string().uuid().optional(),
  limit: z.number().int().positive().max(500).optional(),
})
export type CommsIncrementalSweepJobPayload = z.infer<
  typeof CommsIncrementalSweepJobPayloadSchema
>

/**
 * `comms.subscriptions.renew` — sweep webhook/watch subscriptions expiring
 * within `withinMs` and renew them via each connection's connector. The
 * periodic worker interval enqueues this with a window-bucketed idempotency
 * key so replicas do not double-run the sweep.
 */
export const CommsSubscriptionsRenewJobPayloadSchema = z.object({
  withinMs: z.number().int().positive().optional(),
})
export type CommsSubscriptionsRenewJobPayload = z.infer<
  typeof CommsSubscriptionsRenewJobPayloadSchema
>

/**
 * `comms.webhook.process` — a raw inbound provider webhook delivery handed off
 * from the public API webhook route to the worker. The route answers the HTTP
 * request fast (200) and enqueues this; the worker resolves the connector,
 * verifies + normalizes the delivery via `processWebhook`, persists events, and
 * enqueues an incremental sync for the affected connection(s). Headers are
 * lower-cased and the exact bytes are carried as `rawBody` because providers
 * sign the raw payload.
 */
export const CommsWebhookProcessJobPayloadSchema = z.object({
  provider: z.enum(['slack', 'google', 'microsoft']),
  headers: z.record(z.string()),
  query: z.record(z.string()).optional(),
  rawBody: z.string(),
  receivedAt: z.string(),
})
export type CommsWebhookProcessJobPayload = z.infer<
  typeof CommsWebhookProcessJobPayloadSchema
>

// ── HTTP contract (Individual Communications Connector) ──────────────────────
// Shared request/response shapes for the authenticated `/api/comms/*` surface.
// Credential material is NEVER part of any response schema.

export const CommsConnectionStatusSchema = z.enum([
  'active',
  'needs_reauthorization',
  'disconnected',
  'error',
])
export type CommsConnectionStatus = z.infer<typeof CommsConnectionStatusSchema>

export const CommsSyncPhaseSchema = z.enum([
  'history',
  'incremental',
  'reconciliation',
])
export type CommsSyncPhase = z.infer<typeof CommsSyncPhaseSchema>

export const CommsSyncStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
])
export type CommsSyncStatus = z.infer<typeof CommsSyncStatusSchema>

/** One discoverable container (channel/chat/label/folder) with its include flag. */
export const CommsResourceRecordSchema = z.object({
  id: z.string().uuid(),
  resourceType: z.string(),
  externalId: z.string(),
  name: z.string().nullable(),
  visibility: z.string().nullable(),
  userHasAccess: z.boolean(),
  syncEnabled: z.boolean(),
})
export type CommsResourceRecord = z.infer<typeof CommsResourceRecordSchema>

/** A sync job stripped to status/phase/timestamps — never cursors or errors. */
export const CommsSyncJobRecordSchema = z.object({
  id: z.string().uuid(),
  resourceId: z.string().uuid().nullable(),
  phase: CommsSyncPhaseSchema,
  status: CommsSyncStatusSchema,
  oldestImportedAt: z.string().nullable(),
  newestImportedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CommsSyncJobRecord = z.infer<typeof CommsSyncJobRecordSchema>

/** One capability row as the Permissions section renders it. */
export const CommsCapabilityStateSchema = z.object({
  id: GoogleCapabilityIdSchema,
  label: z.string(),
  explains: z.string(),
  risk: z.enum(['read', 'write', 'send']),
  /** Every required scope is present in the provider's grant. */
  granted: z.boolean(),
  /** Asked for on the last authorization but not granted — the user declined. */
  declined: z.boolean(),
  /** Switched off locally; the provider scope may still be live. */
  blocked: z.boolean(),
})
export type CommsCapabilityState = z.infer<typeof CommsCapabilityStateSchema>

export const CommsCapabilitiesPatchRequestSchema = z.object({
  /** The complete set of locally blocked capability ids after this change. */
  disabledCapabilities: z.array(GoogleCapabilityIdSchema).max(32),
}).strict()
export type CommsCapabilitiesPatchRequest = z.infer<
  typeof CommsCapabilitiesPatchRequestSchema
>

export const CommsConnectionSummarySchema = z.object({
  id: z.string().uuid(),
  provider: CommsProviderSchema,
  status: CommsConnectionStatusSchema,
  externalTenantId: z.string(),
  externalUserId: z.string(),
  grantedScopes: z.array(z.string()),
  initialSyncCompletedAt: z.string().nullable(),
  lastSuccessfulSyncAt: z.string().nullable(),
  resourceCount: z.number().int().nonnegative(),
  syncedResourceCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CommsConnectionSummary = z.infer<
  typeof CommsConnectionSummarySchema
>

export const CommsConnectionDetailSchema = CommsConnectionSummarySchema.extend({
  resources: z.array(CommsResourceRecordSchema),
  recentSyncJobs: z.array(CommsSyncJobRecordSchema),
  /** Present for providers with a capability catalog; empty otherwise. */
  capabilities: z.array(CommsCapabilityStateSchema),
})
export type CommsConnectionDetail = z.infer<typeof CommsConnectionDetailSchema>

export const CommsConnectionListResponseSchema = z.object({
  connections: z.array(CommsConnectionSummarySchema),
})
export type CommsConnectionListResponse = z.infer<
  typeof CommsConnectionListResponseSchema
>

/**
 * Optional body for `POST /api/comms/connections/:provider/start`. An empty
 * body keeps the pre-catalog behaviour: the provider's default capability set.
 */
export const CommsConnectionStartRequestSchema = z.object({
  /** Google capability ids to request. Validated against the catalog. */
  capabilities: GoogleCapabilityListSchema.optional(),
  /**
   * The address the person entered before provider discovery. It is advisory
   * only and becomes an OAuth `login_hint` for a first connection; the callback
   * still proves the account returned by the provider before persistence.
   */
  loginHint: z.string().trim().email().max(320).optional(),
  /**
   * Widen an existing connection rather than creating one. The authorize
   * request asks for the union of its current scopes and the new ones, and the
   * callback refuses if a different provider account completes consent.
   */
  connectionId: z.string().uuid().optional(),
}).strict()
export type CommsConnectionStartRequest = z.infer<
  typeof CommsConnectionStartRequestSchema
>

export const CommsConnectionStartResponseSchema = z.object({
  authorizeUrl: z.string().url(),
})
export type CommsConnectionStartResponse = z.infer<
  typeof CommsConnectionStartResponseSchema
>

export const CommsResourceToggleSchema = z.object({
  resourceId: z.string().uuid(),
  syncEnabled: z.boolean(),
})
export type CommsResourceToggle = z.infer<typeof CommsResourceToggleSchema>

export const CommsResourcesPatchRequestSchema = z.object({
  resources: z.array(CommsResourceToggleSchema).min(1).max(500),
})
export type CommsResourcesPatchRequest = z.infer<
  typeof CommsResourcesPatchRequestSchema
>

/**
 * Whether this deployment can actually complete an OAuth connect for a
 * provider: its adapter registered at startup and its client id is present.
 *
 * Availability is a deployment-configuration fact the browser cannot infer.
 * Without it a surface offers a provider button, the person clicks, and
 * `/start` answers with a server error they can do nothing about — so the
 * surface asks first and offers only what this deployment can finish.
 */
export const CommsProviderAvailabilitySchema = z.object({
  provider: CommsProviderSchema,
  available: z.boolean(),
})
export type CommsProviderAvailability = z.infer<
  typeof CommsProviderAvailabilitySchema
>

export const CommsProvidersResponseSchema = z.object({
  providers: z.array(CommsProviderAvailabilitySchema),
})
export type CommsProvidersResponse = z.infer<
  typeof CommsProvidersResponseSchema
>
