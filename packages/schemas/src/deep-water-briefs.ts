import { z } from 'zod'

import { PaginationMetaSchema } from './api.js'
import {
  DeepWaterBriefContextSchema,
  DeepWaterBriefMessageSchema,
  DeepWaterBriefPillarsSchema,
  DeepWaterBriefSettingKeySchema,
  DeepWaterBriefSettingsEditSchema,
  DeepWaterBriefSettingsSchema,
  DeepWaterBriefSettingsSeedSchema,
  DeepWaterBriefTopicSchema,
} from './deep-water-brief-vocabulary.js'
import { isDeepWaterPublicReportUrl } from './deep-water-ledger-dto.js'
import { DeepWaterResearchProgressSchema } from './deep-water-research-event.js'
import {
  DeepWaterBriefAnalysisSchema,
  DeepWaterDeliveryBlockedReasonSchema,
  DeepWaterOpenQuestionSchema,
  DeepWaterOriginKindSchema,
  DeepWaterPendingActionErrorCodeSchema,
  DeepWaterReportKindSchema,
} from './deep-water-run-state.js'

/**
 * The research-brief views and requests of the Nessie DeepWater API
 * (`/api/integrations/products/deep-water/research-runs`, Water plan nessie.md
 * §7.1–7.2 and §7.9 as amended). A view names a research by Nessie's product
 * run id, never by Ledger's id, and carries no model, vendor, price or
 * infrastructure vocabulary.
 */

const uuid = z.string().uuid()
const timestamp = z.string().min(1)

/** `starting` is the view of a drafting run whose launch is in flight. */
export const DeepWaterResearchRunViewStatusSchema = z.enum([
  'drafting',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type DeepWaterResearchRunViewStatus = z.infer<typeof DeepWaterResearchRunViewStatusSchema>

export const DeepWaterResearchRunOriginViewSchema = z
  .object({
    kind: DeepWaterOriginKindSchema,
    agentId: uuid.nullable(),
    channelId: uuid.nullable(),
    threadId: uuid.nullable(),
    rootMessageId: uuid.nullable(),
    cardMessageId: uuid.nullable(),
  })
  .strict()

export const DeepWaterDeliveryViewSchema = z
  .object({
    state: z.enum(['pending', 'delivered', 'blocked']),
    blockedReason: DeepWaterDeliveryBlockedReasonSchema.nullable(),
  })
  .strict()

/** What the viewer may do — decided by the server, never inferred by a client. */
export const DeepWaterResearchRunViewerSchema = z
  .object({
    canEdit: z.boolean(),
    canStart: z.boolean(),
    canCancel: z.boolean(),
    canRetryDelivery: z.boolean(),
  })
  .strict()

export const DeepWaterResearchRunViewSchema = z
  .object({
    id: uuid,
    status: DeepWaterResearchRunViewStatusSchema,
    topic: z.string(),
    title: z.string().nullable(),
    pillarCount: z.number().int().nonnegative(),
    settings: DeepWaterBriefSettingsSchema.nullable(),
    origin: DeepWaterResearchRunOriginViewSchema,
    requestedByUserId: uuid.nullable(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    sourceCount: z.number().int().nonnegative().nullable(),
    report: z.object({ spaceId: uuid, pageId: uuid }).strict().nullable(),
    reportKind: DeepWaterReportKindSchema.nullable(),
    truncated: z.boolean(),
    /** Which stored artifacts exist; null until the result is delivered. */
    artifacts: z.object({ report: z.boolean(), sources: z.boolean() }).strict().nullable(),
    /** Present only for a finished public report on research.deepwater.live. */
    publicUrl: z.string().refine(isDeepWaterPublicReportUrl).nullable(),
    failure: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    /**
     * The last cancel of this still-open research that did not go through —
     * refused by DeepWater, or DeepWater could not be asked — so whoever
     * cancelled sees why it is still open. Null once a newer cancel is in
     * flight, and on every run that has ended.
     */
    cancelFailure: z
      .object({ code: DeepWaterPendingActionErrorCodeSchema, message: z.string() })
      .strict()
      .nullable(),
    delivery: DeepWaterDeliveryViewSchema,
    /**
     * Where the research stands while it runs, as DeepWater last pushed it
     * (Water plan amendments-streaming S2): its phase, DeepWater's words for
     * the step, a percentage when the step is countable, and the sources
     * found so far. Null unless the research is starting or running with its
     * delivery not blocked, and before DeepWater has said anything.
     */
    progress: DeepWaterResearchProgressSchema.nullable(),
    viewer: DeepWaterResearchRunViewerSchema,
  })
  .strict()
export type DeepWaterResearchRunView = z.infer<typeof DeepWaterResearchRunViewSchema>

/**
 * `GET …/research-runs?cursor&limit` — the runs this viewer may see, newest
 * first. Rows the viewer may not see are left out, and each request reads a
 * bounded number of rows, so a page can be shorter than `limit` — even empty —
 * while `meta.hasMore` is true; `nextCursor` then carries on after the last row
 * read. Only a page with `hasMore: false` is the last. `total` is not counted.
 */
export const DeepWaterResearchRunListSchema = z
  .object({
    items: z.array(DeepWaterResearchRunViewSchema),
    meta: PaginationMetaSchema,
  })
  .strict()
export type DeepWaterResearchRunList = z.infer<typeof DeepWaterResearchRunListSchema>

export const DeepWaterBriefMessageAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: uuid }).strict(),
  z.object({ kind: z.literal('agent'), agentId: uuid }).strict(),
  z.object({ kind: z.literal('planner') }).strict(),
  z.object({ kind: z.literal('event') }).strict(),
])
export type DeepWaterBriefMessageAuthor = z.infer<typeof DeepWaterBriefMessageAuthorSchema>

export const DeepWaterBriefMessageViewSchema = z
  .object({
    id: uuid,
    author: DeepWaterBriefMessageAuthorSchema,
    content: z.string(),
    createdAt: timestamp,
  })
  .strict()
export type DeepWaterBriefMessageView = z.infer<typeof DeepWaterBriefMessageViewSchema>

/**
 * The planner's side of the conversation, derived from register (b) with the
 * action id of a matching pending action. `message` is Nessie's own copy for
 * the failure, never the planner's or DeepWater's error text.
 */
export const DeepWaterPlannerTurnViewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }).strict(),
  z
    .object({ status: z.literal('replying'), actionId: uuid.nullable(), since: timestamp.nullable() })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      actionId: uuid.nullable(),
      retryable: z.boolean(),
      message: z.string(),
    })
    .strict(),
])
export type DeepWaterPlannerTurnView = z.infer<typeof DeepWaterPlannerTurnViewSchema>

export const DeepWaterPendingActionViewSchema = z
  .object({
    kind: z.enum(['scope_start', 'reply', 'launch', 'cancel']),
    actionId: uuid,
    since: timestamp,
    error: z.object({ code: DeepWaterPendingActionErrorCodeSchema, message: z.string() }).strict().nullable(),
  })
  .strict()

export const DeepWaterBriefViewSchema = DeepWaterResearchRunViewSchema.extend({
  /** Null until DeepWater's planner has first answered for this brief. */
  revision: z.number().int().nonnegative().nullable(),
  pillars: z.array(z.string()),
  lockedSettings: z.array(DeepWaterBriefSettingKeySchema),
  ready: z.boolean(),
  openQuestions: z.array(DeepWaterOpenQuestionSchema),
  analysis: DeepWaterBriefAnalysisSchema.nullable(),
  messages: z.array(DeepWaterBriefMessageViewSchema),
  plannerTurn: DeepWaterPlannerTurnViewSchema,
  pendingAction: DeepWaterPendingActionViewSchema.nullable(),
  planner: z.object({ displayName: z.string(), iconUrl: z.string().nullable() }).strict(),
}).strict()
export type DeepWaterBriefView = z.infer<typeof DeepWaterBriefViewSchema>

/** `GET …/research-runs/:runId/artifacts/report` — the stored markdown for Copy markdown. */
export const DeepWaterReportArtifactResponseSchema = z
  .object({
    markdown: z.string(),
    truncated: z.boolean(),
    reportKind: DeepWaterReportKindSchema.nullable(),
  })
  .strict()
export type DeepWaterReportArtifactResponse = z.infer<typeof DeepWaterReportArtifactResponseSchema>

/** Readiness on the `deep-water` entry of `GET /api/integrations/products`. */
export const DeepWaterResearchReadinessStateSchema = z.enum([
  'ready',
  'team_off',
  'contract_outdated',
  'account_not_linked',
  'unavailable',
])
export type DeepWaterResearchReadinessState = z.infer<typeof DeepWaterResearchReadinessStateSchema>

export const DeepWaterResearchReadinessSchema = z
  .object({
    state: DeepWaterResearchReadinessStateSchema,
    /**
     * The viewer is a team owner or admin: the standing that may cancel any
     * open research in the team (amendments N8.5). It is the cancel standing
     * only. Turning DeepWater on or off, or updating it, is owner-only —
     * exactly what `PATCH …/team-enablement` accepts — so a client gates those
     * on the session's owner role, never on this field, and offers an admin
     * no control the route would refuse.
     */
    viewerCanChangeTeam: z.boolean(),
  })
  .strict()
export type DeepWaterResearchReadiness = z.infer<typeof DeepWaterResearchReadinessSchema>

/**
 * The `details` of a 409 that refuses a team transition while a research is
 * still open — `LEDGER_DEEPWATER_ACTIVE_RUNS` on turning DeepWater off or
 * updating it, and the agent-revocation refusal (amendments N8.5). It names
 * the run by id, status, origin and requester only, never its topic, so an
 * owner can cancel it from the `/apps/deep-water` hero without reading it.
 * Not strict: the refusal may name more about the run (its chat), which a
 * reader of these four fields has no use for.
 */
export const DeepWaterActiveRunConflictSchema = z.object({
  id: uuid,
  status: z.string().min(1),
  originKind: DeepWaterOriginKindSchema,
  requestedByUserId: uuid.nullable(),
})
export type DeepWaterActiveRunConflict = z.infer<typeof DeepWaterActiveRunConflictSchema>

// ── Requests ────────────────────────────────────────────────────────────────

/** `personal` resolves on the server to the requester's Personal Assistant DM. */
export const DeepWaterBriefOriginRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('thread'),
      channelId: uuid,
      threadId: uuid,
      rootMessageId: uuid.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('personal') }).strict(),
])
export type DeepWaterBriefOriginRequest = z.infer<typeof DeepWaterBriefOriginRequestSchema>

/** `POST …/research-runs` — open a brief. Replaying an `actionId` returns the same run. */
export const CreateDeepWaterBriefRequestSchema = z
  .object({
    actionId: uuid,
    origin: DeepWaterBriefOriginRequestSchema,
    topic: DeepWaterBriefTopicSchema,
    context: DeepWaterBriefContextSchema.optional(),
    pillars: DeepWaterBriefPillarsSchema.optional(),
    settings: DeepWaterBriefSettingsSeedSchema.optional(),
  })
  .strict()
export type CreateDeepWaterBriefRequest = z.infer<typeof CreateDeepWaterBriefRequestSchema>

const hasEdits = (body: { pillars?: unknown; settings?: unknown }): boolean =>
  body.pillars !== undefined || body.settings !== undefined

/**
 * `POST …/:runId/messages` — reply to the planner; `baseRevision` is required
 * with edits. Alone it is the API's own revision check and never reaches
 * Ledger: the job is built with `deepWaterReplyAction`, which drops it.
 */
export const DeepWaterBriefReplyRequestSchema = z
  .object({
    actionId: uuid,
    message: DeepWaterBriefMessageSchema,
    baseRevision: z.number().int().nonnegative().optional(),
    pillars: DeepWaterBriefPillarsSchema.optional(),
    settings: DeepWaterBriefSettingsEditSchema.optional(),
  })
  .strict()
  .refine((body) => !hasEdits(body) || body.baseRevision !== undefined, {
    message: 'baseRevision is required when pillars or settings are edited.',
    path: ['baseRevision'],
  })
export type DeepWaterBriefReplyRequest = z.infer<typeof DeepWaterBriefReplyRequestSchema>

/**
 * `POST …/:runId/start` — launch the agreed brief at `revision`. `public` is a
 * person-only choice (an agent-started brief is always private).
 */
export const StartDeepWaterBriefRequestSchema = z
  .object({
    actionId: uuid,
    revision: z.number().int().nonnegative(),
    pillars: DeepWaterBriefPillarsSchema.optional(),
    settings: DeepWaterBriefSettingsEditSchema.optional(),
    public: z.boolean().optional(),
  })
  .strict()
export type StartDeepWaterBriefRequest = z.infer<typeof StartDeepWaterBriefRequestSchema>

/** `POST …/:runId/cancel` and `…/:runId/deliver`. */
export const DeepWaterResearchRunActionRequestSchema = z.object({ actionId: uuid }).strict()
export type DeepWaterResearchRunActionRequest = z.infer<typeof DeepWaterResearchRunActionRequestSchema>

/** Synchronous error codes of the brief API. */
export const DEEP_WATER_BRIEF_ERROR_CODES = {
  /** A visible research has no such stored artifact: not delivered yet, or a failed research. */
  ARTIFACT_NOT_FOUND: 'DEEP_WATER_ARTIFACT_NOT_FOUND',
  BRIEF_BUSY: 'DEEP_WATER_BRIEF_BUSY',
  BRIEF_INCOMPLETE: 'DEEP_WATER_BRIEF_INCOMPLETE',
  BRIEF_NOT_EDITABLE: 'DEEP_WATER_BRIEF_NOT_EDITABLE',
  BRIEF_REVISION_CONFLICT: 'DEEP_WATER_BRIEF_REVISION_CONFLICT',
  BRIEF_THREAD_FORBIDDEN: 'DEEP_WATER_BRIEF_THREAD_FORBIDDEN',
  DELIVERY_NOT_BLOCKED: 'DEEP_WATER_DELIVERY_NOT_BLOCKED',
  NOT_READY: 'DEEP_WATER_NOT_READY',
  /** Copy markdown carries the report through the API; past its proxy budget, download it instead. */
  REPORT_TOO_LARGE_TO_COPY: 'DEEP_WATER_REPORT_TOO_LARGE_TO_COPY',
  RESEARCH_NOT_FOUND: 'DEEP_WATER_RESEARCH_NOT_FOUND',
  RUN_NOT_CANCELLABLE: 'DEEP_WATER_RUN_NOT_CANCELLABLE',
  SOURCE_ACCESS: 'DEEP_WATER_SOURCE_ACCESS',
  TEAM_MISMATCH: 'DEEP_WATER_TEAM_MISMATCH',
} as const
