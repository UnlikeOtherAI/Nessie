import { z } from 'zod'

/**
 * The research status event DeepWater (Water) pushes straight to Nessie for
 * research Nessie asked for (Water plan amendments-streaming S1, S2). Ledger
 * connects and meters that work but relays nothing, so this is the one push
 * Nessie receives about a research: its progress, a settled planner turn, and
 * its outcome.
 *
 * The body mirrors Water's own schema (`api/src/lib/nessie-research-event.ts`
 * in the Water repo) member for member and is just as strict: an unknown
 * member, a status that does not belong to its type, or `progress`/`turn`
 * where they do not belong is a malformed body. It carries ids and status
 * only — never report text, names, emails or prices — and the `nessie` ids
 * are Nessie's own, as Ledger asserted them for the call that opened the work.
 *
 * The event is a trigger, never an authority: a turn or an outcome makes the
 * worker read the research through Ledger exactly as the watch would. Only
 * `progress` is stored as sent, because it is the one fact no Ledger read
 * carries.
 */

export const DEEP_WATER_EVENT_VERSION = 'deepwater.research-event.v1'
export const DEEP_WATER_EVENT_SIGNATURE_HEADER = 'x-deepwater-signature'
export const DEEP_WATER_EVENT_ID_HEADER = 'x-deepwater-event-id'
/** `sha256=<hex>` of HMAC-SHA256 over the exact raw body bytes. */
export const DEEP_WATER_EVENT_SIGNATURE_PREFIX = 'sha256='
/** A `sent_at` further than this from Nessie's clock, either way, is refused. */
export const DEEP_WATER_EVENT_MAX_SKEW_MS = 10 * 60_000

export const DEEP_WATER_EVENT_TYPES = [
  'research.progress',
  'research.scope.turn_settled',
  'research.completed',
  'research.failed',
  'research.cancelled',
] as const
export const DeepWaterEventTypeSchema = z.enum(DEEP_WATER_EVENT_TYPES)
export type DeepWaterEventType = z.infer<typeof DeepWaterEventTypeSchema>

/** Where a running research is; Nessie words each phase for people. */
export const DEEP_WATER_PROGRESS_PHASES = [
  'scoping',
  'gathering',
  'synthesising',
  'verifying',
  'writing_report',
] as const
export const DeepWaterProgressPhaseSchema = z.enum(DEEP_WATER_PROGRESS_PHASES)
export type DeepWaterProgressPhase = z.infer<typeof DeepWaterProgressPhaseSchema>

const DEEP_WATER_EVENT_STATUSES = ['drafting', 'running', 'complete', 'failed', 'cancelled'] as const
type DeepWaterEventStatus = typeof DEEP_WATER_EVENT_STATUSES[number]

const identifier = z.string().min(1).max(512)
const timestamp = z.string().datetime()

const researchSchema = z
  .object({
    ledger_research_id: identifier,
    status: z.enum(DEEP_WATER_EVENT_STATUSES),
    title: z.string().min(1).max(200).nullable(),
    report_kind: z.enum(['full', 'summary']).nullable(),
    public_url: z.string().url().startsWith('https://').nullable(),
    error_code: z.string().regex(/^[a-z_]{1,64}$/u).nullable(),
  })
  .strict()

const progressSchema = z
  .object({
    phase: DeepWaterProgressPhaseSchema,
    note: z.string().min(1).max(200),
    percent: z.number().int().min(0).max(100).nullable(),
    sources_found: z.number().int().min(0).nullable(),
    at: timestamp,
  })
  .strict()

const turnSchema = z
  .object({
    turn_id: z.string().uuid(),
    status: z.enum(['complete', 'failed', 'cancelled']),
    revision: z.number().int().min(0),
  })
  .strict()

const nessieIdsSchema = z
  .object({
    organization_id: identifier,
    team_id: identifier,
    user_id: identifier,
    run_id: identifier,
    agent_id: identifier.nullable(),
    tool_call_id: identifier.nullable(),
    thread_id: identifier.nullable(),
  })
  .strict()

/** The research status each type carries, where it carries exactly one. */
const STATUS_FOR_TYPE: Partial<Record<DeepWaterEventType, DeepWaterEventStatus>> = {
  'research.cancelled': 'cancelled',
  'research.completed': 'complete',
  'research.failed': 'failed',
  'research.progress': 'running',
}

/**
 * A brief can be launched between its turn settling and the event being built,
 * so a turn event may already report the research running.
 */
const TURN_EVENT_STATUSES: ReadonlySet<DeepWaterEventStatus> = new Set(['drafting', 'running', 'cancelled'])

export const DeepWaterResearchEventSchema = z
  .object({
    ver: z.literal(DEEP_WATER_EVENT_VERSION),
    event_id: z.string().regex(/^evt_[0-9a-f]{32}$/u),
    type: DeepWaterEventTypeSchema,
    sent_at: timestamp,
    occurred_at: timestamp,
    research: researchSchema,
    progress: progressSchema.nullable(),
    turn: turnSchema.nullable(),
    nessie: nessieIdsSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if ((event.type === 'research.progress') !== (event.progress !== null)) {
      fail('progress is present exactly on research.progress')
    }
    if ((event.type === 'research.scope.turn_settled') !== (event.turn !== null)) {
      fail('turn is present exactly on research.scope.turn_settled')
    }
    if ((event.type === 'research.completed') !== (event.research.report_kind !== null)) {
      fail('report_kind is present exactly on research.completed')
    }
    if (event.research.public_url !== null && event.type !== 'research.completed') {
      fail('public_url is present only on research.completed')
    }
    const expected = STATUS_FOR_TYPE[event.type]
    if (expected !== undefined && event.research.status !== expected) {
      fail(`${event.type} carries research.status ${expected}`)
    }
    if (event.type === 'research.scope.turn_settled' && !TURN_EVENT_STATUSES.has(event.research.status)) {
      fail('research.scope.turn_settled carries research.status drafting, running or cancelled')
    }
  })
export type DeepWaterResearchEvent = z.infer<typeof DeepWaterResearchEventSchema>
export type DeepWaterResearchEventIds = DeepWaterResearchEvent['nessie']

/**
 * Where a running research is, as Nessie stores and shows it
 * (`scope_json.progress`, `ResearchRunView.progress`). `note` is DeepWater's
 * own plain UK English for the step; the phase's words are Nessie's. `at` is
 * when DeepWater observed it, which orders the snapshots: an older one never
 * replaces a newer one.
 */
export const DeepWaterResearchProgressSchema = z
  .object({
    phase: DeepWaterProgressPhaseSchema,
    note: z.string().min(1).max(200),
    percent: z.number().int().min(0).max(100).nullable(),
    sourcesFound: z.number().int().min(0).nullable(),
    at: timestamp,
  })
  .strict()
export type DeepWaterResearchProgress = z.infer<typeof DeepWaterResearchProgressSchema>

/** The progress a `research.progress` event carries, in Nessie's shape. */
export const deepWaterProgressFromEvent = (
  progress: NonNullable<DeepWaterResearchEvent['progress']>,
): DeepWaterResearchProgress => ({
  phase: progress.phase,
  note: progress.note,
  percent: progress.percent,
  sourcesFound: progress.sources_found,
  at: progress.at,
})

// ── The worker job the receiver enqueues ─────────────────────────────────────

/** One received research event, handled by the worker. */
export const DEEP_WATER_RESEARCH_EVENT_TOPIC = 'deep_water.research.event'

/** Keyed by DeepWater's event id, so a redelivered event is queued once. */
export const deepWaterResearchEventJobKey = (eventId: string): string => `deep-water-event:${eventId}`

/** The run the receiver resolved the event to, and the event as verified. */
export const DeepWaterResearchEventJobPayloadSchema = z
  .object({
    organizationId: z.string().uuid(),
    runId: z.string().uuid(),
    event: DeepWaterResearchEventSchema,
  })
  .strict()
export type DeepWaterResearchEventJobPayload = z.infer<typeof DeepWaterResearchEventJobPayloadSchema>
