import { z } from 'zod'

import {
  DeepWaterBriefContextSchema,
  DeepWaterBriefDepthSchema,
  DeepWaterBriefPillarsSchema,
  DeepWaterBriefSettingKeySchema,
  DeepWaterBriefSettingsSchema,
  DeepWaterBriefSettingsSeedSchema,
  DeepWaterBriefTopicSchema,
  toLedgerBriefSettings,
} from './deep-water-brief-vocabulary.js'
import {
  DeepWaterAuthorKindSchema,
  LedgerScopeTurnStatusSchema,
} from './deep-water-ledger-dto.js'
import { DeepWaterResearchProgressSchema } from './deep-water-research-event.js'

/**
 * What a DeepWater brief product run stores (`product_integration_runs`, see
 * migration 20260923090100_deepwater_research_binding). Every JSON column the
 * brief flow writes is parsed through one of these schemas on the way in and
 * on the way out, so a malformed row fails loudly instead of rendering wrong.
 */

const uuid = z.string().uuid()
const timestamp = z.string().min(1)

/**
 * The requester's UOA session identity, captured from a live request or run.
 * Stable UOA ids only — never an email or a name. The epoch is required:
 * Nessie cannot mint a UOA delegation for a session without one, so a brief
 * could never reach Ledger on a null-epoch identity.
 */
export const DeepWaterRequesterIdentitySchema = z
  .object({
    subject: z.string().min(1),
    organizationId: z.string().min(1),
    teamId: z.string().min(1),
    tokenVersion: z.number().int().nonnegative(),
  })
  .strict()
export type DeepWaterRequesterIdentity = z.infer<typeof DeepWaterRequesterIdentitySchema>

/** A consumed-source scope, the shape of the worker's `BasisScopeSchema`. */
export const DeepWaterSourceScopeSchema = z
  .object({ scopeId: z.string().min(1), scopeType: z.string().min(1) })
  .strict()
export type DeepWaterSourceScope = z.infer<typeof DeepWaterSourceScopeSchema>

/** Private-conversation lineage, the shape of the worker's `PrivateConversationSourceSchema`. */
export const DeepWaterDisclosureSourceSchema = z
  .object({
    sourceAuthorUserId: z.string().min(1).nullable(),
    sourceChannelId: z.string().min(1),
  })
  .strict()
export type DeepWaterDisclosureSource = z.infer<typeof DeepWaterDisclosureSourceSchema>

export const DeepWaterSourceScopesSchema = z.array(DeepWaterSourceScopeSchema)
export const DeepWaterDisclosureSourcesSchema = z.array(DeepWaterDisclosureSourceSchema)

export const DeepWaterOriginKindSchema = DeepWaterAuthorKindSchema
export type DeepWaterOriginKind = z.infer<typeof DeepWaterOriginKindSchema>

/**
 * `input_json` of a person-origin brief: what the person asked for when they
 * opened it. The worker's opening `research_scope_start` is built from it, and
 * `originRootMessageId` is where the research card is posted at Start.
 */
export const DeepWaterBriefInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    topic: DeepWaterBriefTopicSchema,
    context: DeepWaterBriefContextSchema.nullable(),
    pillars: DeepWaterBriefPillarsSchema.nullable(),
    settings: DeepWaterBriefSettingsSeedSchema.nullable(),
    originRootMessageId: uuid.nullable(),
  })
  .strict()
export type DeepWaterBriefInput = z.infer<typeof DeepWaterBriefInputSchema>

/**
 * The `research_scope_start` arguments a brief's stored input stands for — the
 * one builder for a brief's opening call and for every replay of it.
 *
 * Ledger answers a repeated tool-call id with the brief it keyed to that call
 * only when the arguments normalise to the same request (it fingerprints the
 * trimmed topic and context, the pillars and the parsed settings), and answers
 * `conflict` otherwise. A replay built any other way than the call it repeats
 * could therefore be refused while Ledger keeps the brief it opened, so the
 * opening call is built here too, never sent as the caller wrote it.
 */
export const deepWaterScopeStartLedgerArgs = (
  input: Pick<DeepWaterBriefInput, 'topic' | 'context' | 'pillars' | 'settings'>,
): Record<string, unknown> => ({
  topic: input.topic,
  ...(input.context ? { context: input.context } : {}),
  ...(input.pillars ? { pillars: input.pillars } : {}),
  ...(input.settings ? { settings: toLedgerBriefSettings(input.settings) } : {}),
})

export const DeepWaterBriefComplexitySchema = z.enum(['low', 'medium', 'high', 'very_high'])

export const DeepWaterBriefAnalysisSchema = z
  .object({
    approach: z.string(),
    complexity: DeepWaterBriefComplexitySchema,
    sourceTypes: z.array(z.string()),
    caveats: z.array(z.string()),
    recommendedDepth: DeepWaterBriefDepthSchema,
    dataFreshness: z.string(),
    estimatedReliability: z.string(),
  })
  .strict()
export type DeepWaterBriefAnalysis = z.infer<typeof DeepWaterBriefAnalysisSchema>

export const DeepWaterOpenQuestionSchema = z
  .object({
    question: z.string(),
    why: z.string(),
    suggestedAnswers: z.array(z.string()),
  })
  .strict()
export type DeepWaterOpenQuestion = z.infer<typeof DeepWaterOpenQuestionSchema>

/** One stored transcript row. Authors resolve through `turnAuthors`, never through Ledger. */
export const DeepWaterStoredMessageSchema = z
  .object({
    id: uuid,
    seq: z.string().regex(/^\d+$/),
    turnId: uuid.nullable(),
    role: z.enum(['requester', 'planner', 'event']),
    authorKind: DeepWaterAuthorKindSchema.nullable(),
    event: z.string().nullable(),
    content: z.string(),
    briefRevision: z.number().int().nonnegative(),
    createdAt: timestamp,
  })
  .strict()
export type DeepWaterStoredMessage = z.infer<typeof DeepWaterStoredMessageSchema>

/**
 * Register (a), the brief content. Replaced only by a strictly greater
 * `revision`. The transcript is a sub-register: a read without the transcript
 * keeps the stored `messages`, and `messagesRevision` records the revision
 * they were captured at, so a later transcript read at an equal revision may
 * still fill them in while nothing can ever roll them back.
 */
export const DeepWaterBriefRegisterSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: z.enum(['drafting', 'launched', 'cancelled']),
    topic: z.string(),
    reply: z.string().nullable(),
    pillars: z.array(z.string()),
    settings: DeepWaterBriefSettingsSchema,
    lockedSettings: z.array(DeepWaterBriefSettingKeySchema),
    openQuestions: z.array(DeepWaterOpenQuestionSchema),
    analysis: DeepWaterBriefAnalysisSchema.nullable(),
    ready: z.boolean(),
    messages: z.array(DeepWaterStoredMessageSchema),
    messagesRevision: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type DeepWaterBriefRegister = z.infer<typeof DeepWaterBriefRegisterSchema>

/**
 * Register (b), the latest planner turn. Replaced only by a lexicographically
 * greater `(seq, rank(status))`; a settled turn is immutable.
 */
export const DeepWaterTurnRegisterSchema = z
  .object({
    id: uuid,
    seq: z.number().int().positive(),
    status: LedgerScopeTurnStatusSchema,
    errorCode: z.string().nullable(),
    retryable: z.boolean(),
    authorKind: DeepWaterAuthorKindSchema,
  })
  .strict()
export type DeepWaterTurnRegister = z.infer<typeof DeepWaterTurnRegisterSchema>

/** Who wrote a turn — Nessie's own record, never taken from Ledger or Water. */
export const DeepWaterTurnAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: uuid }).strict(),
  z.object({ kind: z.literal('agent'), agentId: uuid }).strict(),
])
export type DeepWaterTurnAuthor = z.infer<typeof DeepWaterTurnAuthorSchema>

export const DeepWaterPendingActionKindSchema = z.enum(['scope_start', 'reply', 'launch', 'cancel'])
export type DeepWaterPendingActionKind = z.infer<typeof DeepWaterPendingActionKindSchema>

/** Synchronous Ledger outcomes a person's action can end in (contract §7.1). */
export const DeepWaterPendingActionErrorCodeSchema = z.enum([
  'busy',
  'revision_conflict',
  'not_ready',
  'brief_limit',
  'message_limit',
  'budget_exceeded',
  'forbidden',
  'identity_required',
  'not_drafting',
  'rejected',
  'unavailable',
])
export type DeepWaterPendingActionErrorCode = z.infer<typeof DeepWaterPendingActionErrorCodeSchema>

/**
 * A person's action in flight, or the last one that ended in an error. An
 * action is in flight exactly while `error` is null; a successful action is
 * cleared to null instead. Planner failures are register (b)'s business and
 * never land here.
 */
export const DeepWaterPendingActionSchema = z
  .object({
    kind: DeepWaterPendingActionKindSchema,
    actionId: uuid,
    since: timestamp,
    /** The Ledger turn this action opened, once Ledger has acknowledged it. */
    turnId: uuid.nullable(),
    error: z
      .object({ code: DeepWaterPendingActionErrorCodeSchema, at: timestamp })
      .strict()
      .nullable(),
  })
  .strict()
export type DeepWaterPendingAction = z.infer<typeof DeepWaterPendingActionSchema>

/**
 * `scope_json`: written non-null by both brief insert paths. `progress` is the
 * latest snapshot DeepWater pushed of a running research (Water plan
 * amendments-streaming S2), replaced only by one DeepWater observed later; a
 * row written before the push existed has none.
 */
export const DeepWaterScopeStateSchema = z
  .object({
    brief: DeepWaterBriefRegisterSchema.nullable(),
    turn: DeepWaterTurnRegisterSchema.nullable(),
    turnAuthors: z.record(uuid, DeepWaterTurnAuthorSchema),
    pendingAction: DeepWaterPendingActionSchema.nullable(),
    progress: DeepWaterResearchProgressSchema.nullable().default(null),
  })
  .strict()
export type DeepWaterScopeState = z.infer<typeof DeepWaterScopeStateSchema>

export const emptyDeepWaterScopeState = (): DeepWaterScopeState => ({
  brief: null,
  turn: null,
  turnAuthors: {},
  pendingAction: null,
  progress: null,
})

/** Why a finished research could not be delivered, and the one remedy each names. */
export const DeepWaterDeliveryBlockedReasonSchema = z.enum([
  'requester_identity_changed',
  'ledger_unavailable',
  'report_expired',
  'report_malformed',
  'knowledge_destination_unavailable',
])
export type DeepWaterDeliveryBlockedReason = z.infer<typeof DeepWaterDeliveryBlockedReasonSchema>

/**
 * Blocks that `/deliver` can clear: the run stays `running` so its connector is
 * kept. The others are final and write `completed` in the same statement.
 */
export const DEEP_WATER_RETRYABLE_DELIVERY_BLOCKS: ReadonlySet<DeepWaterDeliveryBlockedReason> = new Set([
  'requester_identity_changed',
  'ledger_unavailable',
  'knowledge_destination_unavailable',
])

export const DeepWaterReportKindSchema = z.enum(['full', 'summary'])
export type DeepWaterReportKind = z.infer<typeof DeepWaterReportKindSchema>

/**
 * `failure_code`: Ledger's job error code, or one of Nessie's own
 * (`start_unconfirmed`, `start_identity_changed`).
 */
export const DeepWaterFailureCodeSchema = z.string().regex(/^[a-z_]{1,64}$/)

/** The reap gave up a brief DeepWater never confirmed within its window. */
export const DEEP_WATER_START_UNCONFIRMED = 'start_unconfirmed'

/**
 * The reap gave up a brief whose opening was stopped by its requester's
 * changed sign-in, and which they did not renew within the window.
 */
export const DEEP_WATER_START_IDENTITY_CHANGED = 'start_identity_changed'

/**
 * Nessie's own codes for a brief the reap gave up. A confirmation that arrives
 * later still attaches such a brief (N1): it was never refused.
 */
export const DEEP_WATER_REAPED_FAILURE_CODES: ReadonlySet<string> = new Set([
  DEEP_WATER_START_UNCONFIRMED,
  DEEP_WATER_START_IDENTITY_CHANGED,
])
