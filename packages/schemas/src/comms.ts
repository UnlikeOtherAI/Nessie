import { z } from 'zod'

/**
 * Queue topics for the Individual Communications Connector sync pipeline. The
 * worker registers a handler per topic; provider adapters plug into the shared
 * connector registry later. See
 * docs/plans/2026-07-21-individual-communications-connector.md.
 */
export const COMMS_SYNC_INITIAL_TOPIC = 'comms.sync.initial'
export const COMMS_SYNC_INCREMENTAL_TOPIC = 'comms.sync.incremental'
export const COMMS_SUBSCRIPTIONS_RENEW_TOPIC = 'comms.subscriptions.renew'
export const COMMS_WEBHOOK_PROCESS_TOPIC = 'comms.webhook.process'

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

export const CommsProviderSchema = z.enum(['slack', 'google', 'microsoft'])
export type CommsProvider = z.infer<typeof CommsProviderSchema>

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
})
export type CommsConnectionDetail = z.infer<typeof CommsConnectionDetailSchema>

export const CommsConnectionListResponseSchema = z.object({
  connections: z.array(CommsConnectionSummarySchema),
})
export type CommsConnectionListResponse = z.infer<
  typeof CommsConnectionListResponseSchema
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
