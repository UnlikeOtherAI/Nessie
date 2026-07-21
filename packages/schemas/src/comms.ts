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
