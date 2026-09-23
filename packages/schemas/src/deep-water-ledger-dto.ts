import { z } from 'zod'

import {
  DeepWaterBriefDepthSchema,
  DeepWaterBriefRecencySchema,
  DeepWaterChapterDepthSchema,
  DeepWaterLanguageCodeSchema,
  DeepWaterOutputLanguageSchema,
  DeepWaterSearchQualitySchema,
  DeepWaterWritingStyleSchema,
  deepWaterBriefSettingKeyFromWire,
  type DeepWaterBriefSettingKey,
} from './deep-water-brief-vocabulary.js'

/**
 * Ledger's DeepWater research DTOs as Nessie reads them (Water plan ledger.md
 * §5.3, amendments L4 `turn.seq`, L7 `report_kind`, §5.8 `public_url`).
 *
 * Tolerant in the one way a consumer of a still-evolving producer must be:
 * fields Nessie does not know are ignored, and fields Ledger added after this
 * release (`title`, `brief`, `error_code`, `seq`, `report_kind`, `public_url`)
 * are accepted when present and default to null when absent. Values are not
 * tolerated: a status, turn state or setting outside the contract fails the
 * parse, so the caller sees a malformed response instead of a guess.
 *
 * Every schema maps the wire's snake_case onto Nessie's camelCase, so nothing
 * past this file handles Ledger field names.
 */

/** Ledger's public research id — the only Ledger id Nessie stores. */
export const LEDGER_RESEARCH_ID_PATTERN = /^rs_[A-Za-z0-9_-]+$/
export const LedgerResearchIdSchema = z.string().regex(LEDGER_RESEARCH_ID_PATTERN)

const ErrorCodeSchema = z.string().regex(/^[a-z_]{1,64}$/)
const nullableErrorCode = ErrorCodeSchema.nullish().transform((value) => value ?? null)
const nullableString = z.string().nullish().transform((value) => value ?? null)

/** The only origin a public report link may have. */
export const DEEP_WATER_PUBLIC_REPORT_ORIGIN = 'https://research.deepwater.live'

const isPublicReportUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.origin === DEEP_WATER_PUBLIC_REPORT_ORIGIN
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/**
 * Ledger passes `public_url` through only from Water's exact public origin, so
 * any other origin reaching Nessie is a contract violation and fails the parse.
 */
const nullablePublicUrl = z
  .string()
  .refine(isPublicReportUrl, { message: `public_url must be on ${DEEP_WATER_PUBLIC_REPORT_ORIGIN}` })
  .nullish()
  .transform((value) => value ?? null)

export const LedgerResearchStatusSchema = z.enum([
  'drafting',
  'starting',
  'running',
  'needs_setup',
  'complete',
  'failed',
  'timed_out',
  'cancelled',
])
export type LedgerResearchStatus = z.infer<typeof LedgerResearchStatusSchema>

export const LedgerScopeTurnStatusSchema = z.enum([
  'dispatching',
  'pending',
  'complete',
  'failed',
  'cancelled',
])
export type LedgerScopeTurnStatus = z.infer<typeof LedgerScopeTurnStatusSchema>

export const DeepWaterAuthorKindSchema = z.enum(['person', 'agent'])
export type DeepWaterAuthorKind = z.infer<typeof DeepWaterAuthorKindSchema>

/** Ledger's latest planner turn for a brief. A settled turn is immutable. */
export const LedgerScopeTurnSchema = z
  .object({
    id: z.string().uuid(),
    seq: z.number().int().positive(),
    status: LedgerScopeTurnStatusSchema,
    author_kind: DeepWaterAuthorKindSchema,
    error_code: nullableErrorCode,
    retryable: z.boolean().optional().default(false),
  })
  .transform((turn) => ({
    id: turn.id,
    seq: turn.seq,
    status: turn.status,
    authorKind: turn.author_kind,
    errorCode: turn.error_code,
    retryable: turn.retryable,
  }))
export type LedgerScopeTurn = z.output<typeof LedgerScopeTurnSchema>

const LedgerBriefSettingsSchema = z
  .object({
    depth: DeepWaterBriefDepthSchema,
    chapter_depth: DeepWaterChapterDepthSchema,
    search_quality: DeepWaterSearchQualitySchema,
    languages: z.array(DeepWaterLanguageCodeSchema),
    output_language: DeepWaterOutputLanguageSchema,
    recency: DeepWaterBriefRecencySchema,
    writing_style: DeepWaterWritingStyleSchema,
  })
  .transform((settings) => ({
    depth: settings.depth,
    chapterDepth: settings.chapter_depth,
    searchQuality: settings.search_quality,
    languages: settings.languages,
    outputLanguage: settings.output_language,
    recency: settings.recency,
    writingStyle: settings.writing_style,
  }))

/**
 * Locked keys arrive as wire names. A key Nessie does not know names a setting
 * it cannot show or edit, so it is left out of the projection.
 */
const LockedSettingsSchema = z.array(z.string()).transform((keys) =>
  keys
    .map(deepWaterBriefSettingKeyFromWire)
    .filter((key): key is DeepWaterBriefSettingKey => key !== null))

const OpenQuestionSchema = z
  .object({
    question: z.string().max(500),
    why: z.string().max(300),
    suggested_answers: z.array(z.string().max(200)).max(4),
  })
  .transform((question) => ({
    question: question.question,
    why: question.why,
    suggestedAnswers: question.suggested_answers,
  }))

const COMPLEXITY = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  'Very high': 'very_high',
} as const

const AnalysisSchema = z
  .object({
    approach: z.string(),
    complexity: z.enum(['Low', 'Medium', 'High', 'Very high']),
    source_types: z.array(z.string()),
    caveats: z.array(z.string()),
    recommended_depth: DeepWaterBriefDepthSchema,
    data_freshness: z.string(),
    estimated_reliability: z.string(),
  })
  .transform((analysis) => ({
    approach: analysis.approach,
    complexity: COMPLEXITY[analysis.complexity],
    sourceTypes: analysis.source_types,
    caveats: analysis.caveats,
    recommendedDepth: analysis.recommended_depth,
    dataFreshness: analysis.data_freshness,
    estimatedReliability: analysis.estimated_reliability,
  }))

/** One transcript row, passed through from Water with its turn id. */
export const LedgerScopeMessageSchema = z
  .object({
    id: z.string().uuid(),
    // Water serialises the bigint sequence as a string.
    seq: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
      .transform((value) => String(value)),
    turn_id: z.string().uuid().nullish().transform((value) => value ?? null),
    role: z.enum(['requester', 'planner', 'event']),
    author_kind: DeepWaterAuthorKindSchema.nullish().transform((value) => value ?? null),
    event: nullableString,
    content: z.string(),
    brief_revision: z.number().int().nonnegative(),
    created_at: z.string().min(1),
  })
  .transform((message) => ({
    id: message.id,
    seq: message.seq,
    turnId: message.turn_id,
    role: message.role,
    authorKind: message.author_kind,
    event: message.event,
    content: message.content,
    briefRevision: message.brief_revision,
    createdAt: message.created_at,
  }))
export type LedgerScopeMessage = z.output<typeof LedgerScopeMessageSchema>

/**
 * Water's brief as Ledger passes it through. `messages` is present only when
 * the read asked for the transcript; absent is not the same as empty.
 */
export const LedgerScopeBriefSchema = z
  .object({
    state: z.enum(['drafting', 'launched', 'cancelled']),
    revision: z.number().int().nonnegative(),
    topic: z.string(),
    reply: nullableString,
    pillars: z.array(z.string()),
    settings: LedgerBriefSettingsSchema,
    locked_settings: LockedSettingsSchema,
    open_questions: z.array(OpenQuestionSchema),
    analysis: AnalysisSchema.nullish().transform((value) => value ?? null),
    ready: z.boolean(),
    messages: z.array(LedgerScopeMessageSchema).optional(),
  })
  .transform((brief) => ({
    state: brief.state,
    revision: brief.revision,
    topic: brief.topic,
    reply: brief.reply,
    pillars: brief.pillars,
    settings: brief.settings,
    lockedSettings: brief.locked_settings,
    openQuestions: brief.open_questions,
    analysis: brief.analysis,
    ready: brief.ready,
    messages: brief.messages ?? null,
  }))
export type LedgerScopeBrief = z.output<typeof LedgerScopeBriefSchema>

/** What every `research_scope_*` tool returns. */
export const LedgerScopeResultSchema = z
  .object({
    id: LedgerResearchIdSchema,
    status: LedgerResearchStatusSchema,
    error_code: nullableErrorCode,
    title: nullableString,
    turn: LedgerScopeTurnSchema.nullish().transform((value) => value ?? null),
    brief: LedgerScopeBriefSchema.nullish().transform((value) => value ?? null),
  })
  .transform((result) => ({
    id: result.id,
    status: result.status,
    errorCode: result.error_code,
    title: result.title,
    turn: result.turn,
    brief: result.brief,
  }))
export type LedgerScopeResult = z.output<typeof LedgerScopeResultSchema>

const ProgressSchema = z.object({
  phase: z.string(),
  percent: z.number().optional(),
  note: z.string().optional(),
  sources_found: z.number().int().nonnegative().optional(),
})

/** `research_status`, `GET /v1/research/:id` and `research_list` rows. */
export const LedgerResearchStatusDtoSchema = z
  .object({
    id: LedgerResearchIdSchema,
    status: LedgerResearchStatusSchema,
    progress: ProgressSchema.optional(),
    eta_minutes: z.number().nonnegative().optional(),
    title: nullableString,
    error_code: nullableErrorCode,
    brief: z
      .object({
        revision: z.number().int().nonnegative().nullable(),
        turn_pending: z.boolean(),
      })
      .optional(),
    public_url: nullablePublicUrl,
  })
  .transform((dto) => ({
    id: dto.id,
    status: dto.status,
    phase: dto.progress?.phase ?? null,
    sourcesFound: dto.progress?.sources_found ?? null,
    etaMinutes: dto.eta_minutes ?? null,
    title: dto.title,
    errorCode: dto.error_code,
    brief: dto.brief ? { revision: dto.brief.revision, turnPending: dto.brief.turn_pending } : null,
    publicUrl: dto.public_url,
  }))
export type LedgerResearchStatusDto = z.output<typeof LedgerResearchStatusDtoSchema>

export const LedgerResearchReferenceSchema = z
  .object({
    title: z.string(),
    url: z.string().min(1),
    accessed_at: z.string().min(1),
  })
  .transform((reference) => ({
    title: reference.title,
    url: reference.url,
    accessedAt: reference.accessed_at,
  }))
export type LedgerResearchReference = z.output<typeof LedgerResearchReferenceSchema>

/**
 * `research_report`. `report_kind` follows amendment N10: a missing or unknown
 * value is null, which every surface labels with the neutral word "report".
 */
export const LedgerResearchReportSchema = z
  .object({
    report_markdown: z.string(),
    references: z.array(LedgerResearchReferenceSchema),
    depth: z.string(),
    started_at: z.string().min(1),
    completed_at: nullableString,
    truncated: z.boolean(),
    title: nullableString,
    report_kind: z.enum(['full', 'summary']).nullish().catch(null).transform((value) => value ?? null),
    full_report_error_code: nullableErrorCode,
    public_url: nullablePublicUrl,
  })
  .transform((report) => ({
    reportMarkdown: report.report_markdown,
    references: report.references,
    depth: report.depth,
    startedAt: report.started_at,
    completedAt: report.completed_at,
    truncated: report.truncated,
    title: report.title,
    reportKind: report.report_kind,
    fullReportErrorCode: report.full_report_error_code,
    publicUrl: report.public_url,
  }))
export type LedgerResearchReport = z.output<typeof LedgerResearchReportSchema>

/** `research_scope_launch` (and `research_start`) return a ticket. */
export const LedgerResearchTicketSchema = z
  .object({
    id: LedgerResearchIdSchema,
    job_id: LedgerResearchIdSchema,
    status: LedgerResearchStatusSchema,
  })
  .refine((ticket) => ticket.id === ticket.job_id, {
    message: 'ticket id and job_id must name the same research',
  })
  .transform((ticket) => ({ id: ticket.id, status: ticket.status }))
export type LedgerResearchTicket = z.output<typeof LedgerResearchTicketSchema>

/** The `structuredContent` of an MCP tool error from Ledger. */
export const LedgerToolErrorSchema = z
  .object({
    error: z.string().min(1),
    error_description: z.string().optional(),
    status_code: z.number().int().optional(),
    current_revision: z.number().int().nonnegative().optional(),
  })
  .transform((error) => ({
    code: error.error,
    description: error.error_description ?? null,
    statusCode: error.status_code ?? null,
    currentRevision: error.current_revision ?? null,
  }))
export type LedgerToolError = z.output<typeof LedgerToolErrorSchema>
