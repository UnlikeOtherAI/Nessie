import { z } from 'zod'

import { TaskPrioritySchema } from './task-records.js'

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
 * - `agent`: a worker ticket tool, with the run it came from when there is one.
 * - `source`: an inbound board-source sync.
 * - `system`: everything else, including migrations and platform teardown.
 *
 * Every variant is strict, so a `session` origin cannot also carry an agent.
 */
export const TaskEventOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }).strict(),
  z.object({ kind: z.literal('token'), keyId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('agent'), agentId: uuid, runId: uuid.optional() }).strict(),
  z.object({ kind: z.literal('source'), boardSourceId: uuid }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
])
export type TaskEventOrigin = z.infer<typeof TaskEventOriginSchema>

/**
 * `by` is what `taskEventBy` (`@nessie/team-admin`) returns: the member's user
 * id, or `agent:<id>` for an agent run with no person behind it. It is absent
 * when neither authored the change (a source sync, the platform).
 */
const authoredEventShape = {
  by: z.string().min(1).optional(),
  origin: TaskEventOriginSchema,
}

// A `session` or `token` origin always names the member who holds that session
// or key: a pickup asks whether exactly that member can edit the board.
const requireMemberForPersonOrigins = (
  payload: { by?: string | undefined; origin: TaskEventOrigin },
  context: z.RefinementCtx,
): void => {
  const { kind } = payload.origin
  if ((kind === 'session' || kind === 'token') && !uuid.safeParse(payload.by).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['by'],
      message: `A ${kind} origin names the member it authenticated.`,
    })
  }
}

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
    requireMemberForPersonOrigins(payload, context)
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
    requireMemberForPersonOrigins(payload, context)
    if (payload.from === payload.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'A priority_changed event changes the priority.',
      })
    }
  })
export type PriorityChangedTaskEventPayload = z.infer<typeof PriorityChangedTaskEventPayloadSchema>
