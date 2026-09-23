import { z } from 'zod'

import {
  DeepWaterBriefMessageSchema,
  DeepWaterBriefPillarsSchema,
  DeepWaterBriefSettingsEditSchema,
} from './deep-water-brief-vocabulary.js'
import { DeepWaterRequesterIdentitySchema } from './deep-water-run-state.js'
import type { DeepWaterBriefReplyRequest } from './deep-water-briefs.js'

/**
 * Queue contracts between the Nessie API, which persists a person's brief
 * action and enqueues it in one transaction, and the worker, which is the only
 * process that calls Ledger (the API holds no DeepWater identity path and
 * drains in 25 s). Payloads carry ids and the action's own arguments; the
 * brief as opened lives on the run row (`input_json`), not in the queue.
 */

const uuid = z.string().uuid()

/** One person action on a brief: open, reply, launch or cancel. */
export const DEEP_WATER_BRIEF_ACTION_TOPIC = 'deep_water.brief.action'

/** Import and deliver a finished research, or retry a blocked delivery. */
export const DEEP_WATER_RUN_DELIVER_TOPIC = 'deep_water.run.deliver'

/** One watch read of an open brief or research through Ledger. */
export const DEEP_WATER_RUN_WATCH_TOPIC = 'deep_water.run.watch'

export const deepWaterBriefActionJobKey = (runId: string, actionId: string): string =>
  `deep-water-brief-action:${runId}:${actionId}`

export const deepWaterRunDeliverJobKey = (runId: string, actionId: string): string =>
  `deep-water-deliver:${runId}:${actionId}`

export const deepWaterRunWatchJobKey = (runId: string, reconcileSeq: number): string =>
  `deep-water-watch:${runId}:${reconcileSeq}`

const hasEdits = (action: { pillars?: unknown; settings?: unknown }): boolean =>
  action.pillars !== undefined || action.settings !== undefined

export const DeepWaterBriefActionSchema = z.discriminatedUnion('kind', [
  /** Arguments come from the run's `input_json`, written when the brief was opened. */
  z.object({ kind: z.literal('scope_start') }).strict(),
  z
    .object({
      kind: z.literal('reply'),
      message: DeepWaterBriefMessageSchema,
      baseRevision: z.number().int().nonnegative().optional(),
      pillars: DeepWaterBriefPillarsSchema.optional(),
      settings: DeepWaterBriefSettingsEditSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('launch'),
      revision: z.number().int().nonnegative(),
      pillars: DeepWaterBriefPillarsSchema.optional(),
      settings: DeepWaterBriefSettingsEditSchema.optional(),
      public: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('cancel') }).strict(),
])
export type DeepWaterBriefAction = z.infer<typeof DeepWaterBriefActionSchema>

/**
 * `actor.role` is `requester` for the person's own brief, or `owner` for a team
 * owner or admin cancelling someone else's run with their own identity
 * (amendments-fable F3). The identity is the acting person's live session,
 * captured from the request that enqueued the job.
 *
 * `acceptedAt` is when Nessie accepted the action — for a brief, the same
 * instant as its `pendingAction.since`. The worker's retry window runs from
 * it: the queue row's own `enqueued_at` moves forward on every retry, so it
 * cannot bound one.
 */
export const DeepWaterBriefActionJobPayloadSchema = z
  .object({
    organizationId: uuid,
    runId: uuid,
    actionId: uuid,
    acceptedAt: z.string().datetime({ offset: true }),
    actor: z
      .object({
        userId: uuid,
        role: z.enum(['requester', 'owner']),
        identity: DeepWaterRequesterIdentitySchema,
      })
      .strict(),
    action: DeepWaterBriefActionSchema,
  })
  .strict()
  // Ledger's `research_scope_reply` takes `base_revision` exactly when pillars
  // or settings are edited, and refuses it on a plain reply; the job is what
  // the worker forwards, so it holds Ledger's rule, not the request's.
  .refine(
    (payload) => payload.action.kind !== 'reply'
      || hasEdits(payload.action) === (payload.action.baseRevision !== undefined),
    {
      message: 'A reply carries its base revision exactly when it edits pillars or settings.',
      path: ['action', 'baseRevision'],
    },
  )
  .refine(
    (payload) => payload.actor.role === 'requester' || payload.action.kind === 'cancel',
    { message: 'Only a cancel may act on someone else\'s brief.', path: ['actor', 'role'] },
  )
export type DeepWaterBriefActionJobPayload = z.infer<typeof DeepWaterBriefActionJobPayloadSchema>

/**
 * The job action for a person's reply (`POST …/:runId/messages`). The request
 * may carry `baseRevision` without edits — the API checks it against the brief
 * it has, to refuse a reply to a brief that moved on — but Ledger refuses a
 * `base_revision` that edits nothing, so it travels only with the edits.
 */
export const deepWaterReplyAction = (
  request: Pick<DeepWaterBriefReplyRequest, 'message' | 'baseRevision' | 'pillars' | 'settings'>,
): Extract<DeepWaterBriefAction, { kind: 'reply' }> => {
  if (!hasEdits(request)) return { kind: 'reply', message: request.message }
  if (request.baseRevision === undefined) {
    throw new Error('A reply that edits the brief carries the revision it edited.')
  }
  return {
    kind: 'reply',
    message: request.message,
    baseRevision: request.baseRevision,
    ...(request.pillars !== undefined ? { pillars: request.pillars } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  }
}

/**
 * `identity` is the live identity of a person retrying a blocked delivery; it
 * replaces the captured one only for the same UOA subject, organisation and
 * team. Null for a delivery the watch started.
 */
export const DeepWaterRunDeliverJobPayloadSchema = z
  .object({
    organizationId: uuid,
    runId: uuid,
    actionId: uuid,
    identity: DeepWaterRequesterIdentitySchema.nullable(),
  })
  .strict()
export type DeepWaterRunDeliverJobPayload = z.infer<typeof DeepWaterRunDeliverJobPayloadSchema>

export const DeepWaterRunWatchJobPayloadSchema = z
  .object({
    organizationId: uuid,
    runId: uuid,
    reconcileSeq: z.number().int().nonnegative(),
  })
  .strict()
export type DeepWaterRunWatchJobPayload = z.infer<typeof DeepWaterRunWatchJobPayloadSchema>
