import { z } from 'zod'

import { TaskPrioritySchema } from './task-records.js'
import { TicketWorkStateReasonSchema, TicketWorkStatusSchema } from './ticket-work.js'

/**
 * `TaskEvent` payload contracts for ticket-driven agents
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "Ticket events and
 * their provenance"). A ticket trigger decides from these fields alone whether
 * an event may start or steer work, so they are stated here rather than left
 * to each writer. Ids are plain uuids, not branded: writers stamp them from
 * Prisma rows and the dispatcher reads them straight back against Prisma.
 */
const uuid = z.string().uuid()

/**
 * Which authenticated door a ticket change came through. The layer that
 * authenticated the call stamps it, never the caller, and it is an allowlist
 * like `PERSON_MESSAGE_AUTHORSHIP`: only a route authenticated by a person's
 * own browser or app session writes `session`, and only a `session` event can
 * start or steer ticket work.
 *
 * - `token`: an API key or the MCP surface, which act for a member without
 *   that member being at a screen.
 * - `agent`: a worker ticket tool, with the run it came from. Agents write
 *   only from inside a run, so the run is always known.
 * - `source`: an inbound board-source sync.
 * - `system`: everything else, including migrations and platform teardown.
 *
 * Every variant is strict, so a `session` origin cannot also carry an agent.
 */
export const TaskEventOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }).strict(),
  z.object({ kind: z.literal('token'), keyId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('agent'), agentId: uuid, runId: uuid }).strict(),
  z.object({ kind: z.literal('source'), boardSourceId: uuid }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
])
export type TaskEventOrigin = z.infer<typeof TaskEventOriginSchema>

/**
 * `by` is the author the ticket's history names. A person's session or key,
 * and an agent run acting for the person who asked, write what `taskEventBy`
 * (`@nessie/team-admin`) returns: the member's user id, or `agent:<id>` for an
 * unattended agent run with no person behind it. A source sync writes
 * `source:<boardSourceId>` (`board-source-apply.ts`). It is absent only when
 * nobody authored the change (the platform).
 */
const authoredEventShape = {
  by: z.string().min(1).optional(),
  origin: TaskEventOriginSchema,
}

/**
 * `by` must agree with the origin, because the dispatcher decides from these
 * fields alone: a `session` or `token` origin names the member who holds that
 * session or key (a pickup asks whether exactly that member can edit the
 * board); an `agent` origin names that same agent or the member its run acted
 * for; a `source` origin names that same source when it names anything.
 */
const requireAuthorMatchingOrigin = (
  payload: { by?: string | undefined; origin: TaskEventOrigin },
  context: z.RefinementCtx,
): void => {
  const { by, origin } = payload
  const isMember = uuid.safeParse(by).success
  let problem: string | null = null
  if ((origin.kind === 'session' || origin.kind === 'token') && !isMember) {
    problem = `A ${origin.kind} origin names the member it authenticated.`
  } else if (origin.kind === 'agent' && !isMember && by !== `agent:${origin.agentId}`) {
    problem = 'An agent origin names that agent, or the member its run acted for.'
  } else if (origin.kind === 'source' && by !== undefined && by !== `source:${origin.boardSourceId}`) {
    problem = 'A source origin names that source.'
  }
  if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ['by'], message: problem })
}

/**
 * The authorship every ticket-trigger event carries, read from any event type
 * the dispatcher acts on (`comment_added`, `detail_edited`, `labels_changed`,
 * `assigned`, …) without restating each type's own fields. Unknown keys pass
 * through, so a writer's own fields survive a parse.
 */
export const TaskEventAuthorshipSchema = z
  .object(authoredEventShape)
  .passthrough()
  .superRefine(requireAuthorMatchingOrigin)
export type TaskEventAuthorship = z.infer<typeof TaskEventAuthorshipSchema>

/**
 * `created`: where a new ticket landed, as its home board placed it when it
 * was written. A ticket created straight into a start-work column is a
 * pickup under the same origin rule as a move, so the column is stamped by
 * the writer rather than re-derived later from a ticket that may have moved
 * since. Both are null for a projectless ticket, or a board with no column
 * for its status.
 */
export const CreatedTaskEventPayloadSchema = z
  .object({
    ...authoredEventShape,
    boardId: uuid.nullable(),
    columnId: uuid.nullable(),
  })
  .passthrough()
  .superRefine(requireAuthorMatchingOrigin)
export type CreatedTaskEventPayload = z.infer<typeof CreatedTaskEventPayloadSchema>

/**
 * `column_entered`: written on every column change, including a move between
 * two columns of the same category, which changes no status and so writes no
 * `status_changed`. `fromColumnId` is the column the ticket left, or null when
 * it had no placement before the move.
 */
export const ColumnEnteredTaskEventPayloadSchema = z
  .object({
    ...authoredEventShape,
    fromColumnId: uuid.nullable(),
    toColumnId: uuid,
  })
  .superRefine((payload, context) => {
    requireAuthorMatchingOrigin(payload, context)
    if (payload.fromColumnId === payload.toColumnId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toColumnId'],
        message: 'A column_entered event changes the column.',
      })
    }
  })
export type ColumnEnteredTaskEventPayload = z.infer<typeof ColumnEnteredTaskEventPayloadSchema>

/** `priority_changed`: written when a ticket's priority changes. */
export const PriorityChangedTaskEventPayloadSchema = z
  .object({
    ...authoredEventShape,
    from: TaskPrioritySchema,
    to: TaskPrioritySchema,
  })
  .superRefine((payload, context) => {
    requireAuthorMatchingOrigin(payload, context)
    if (payload.from === payload.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'A priority_changed event changes the priority.',
      })
    }
  })
export type PriorityChangedTaskEventPayload = z.infer<typeof PriorityChangedTaskEventPayloadSchema>

/**
 * The ticket-activity rows a work record writes, so the ticket says what its
 * agent's work did and why (docs/standards/ticket-work.md → "What the project
 * sees"). They are history only: none is a type a ticket trigger acts on, so
 * none is dispatched. `work_started` and `work_ended` are written from T1;
 * `work_queued`, `work_paused` and `work_resumed` belong to the machine queue
 * and are named here so every reader already knows them.
 */
export const TICKET_WORK_ACTIVITY_EVENT_TYPES = [
  'work_started',
  'work_queued',
  'work_paused',
  'work_resumed',
  'work_ended',
] as const
export type TicketWorkActivityEventType = (typeof TICKET_WORK_ACTIVITY_EVENT_TYPES)[number]

/**
 * A work row is the platform's, whoever caused it, so its origin is `system`;
 * `by` names who caused it where someone did — the person whose move started
 * or ended the work, `agent:<id>` for the agent's own move — and is absent
 * when the platform acted on its own (a limit, a disabled trigger).
 */
export const TicketWorkActivityPayloadSchema = z
  .object({
    by: z.string().min(1).optional(),
    origin: z.object({ kind: z.literal('system') }).strict(),
    workId: uuid,
    triggerId: uuid.nullable(),
    agentId: uuid,
    status: TicketWorkStatusSchema,
    reason: TicketWorkStateReasonSchema.nullable(),
  })
  .strict()
export type TicketWorkActivityPayload = z.infer<typeof TicketWorkActivityPayloadSchema>
