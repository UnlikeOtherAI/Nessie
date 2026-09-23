import { z } from 'zod'

import { AgentIdSchema, ChannelIdSchema, TaskIdSchema, ThreadIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'
import { TicketTriggerSkipReasonSchema } from './ticket-triggers.js'
import {
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
  TicketWorkWakeReasonSchema,
} from './ticket-work.js'

/**
 * What the project sees of a ticket's work (docs/standards/ticket-work.md →
 * "What the project sees"): the chip in the ticket dialog, the dot on the
 * board card, the column badge and the work thread's posting rule.
 *
 * Every read is readable by the project audience, because anyone who can move
 * a ticket needs to know what moving it did. None names a machine: a private
 * executor's label is not the room's to see. The owner-only Triggers routes
 * stay owner-only; nothing here needs them.
 */

const uuid = z.string().uuid()

/** One work record as the ticket dialog's chip shows it. */
export const TicketWorkChipRecordSchema = z.object({
  id: uuid,
  /** Null once the trigger was deleted: the record and its story outlive it. */
  triggerId: uuid.nullable(),
  agent: z.object({ id: AgentIdSchema, name: z.string() }),
  status: TicketWorkStatusSchema,
  stateReason: TicketWorkStateReasonSchema.nullable(),
  startedAt: TimestampSchema,
  /** The person whose move started it, by name. */
  startedByName: z.string().nullable(),
  endedAt: TimestampSchema.nullable(),
  lastWakeAt: TimestampSchema.nullable(),
  lastWakeReason: TicketWorkWakeReasonSchema.nullable(),
  wakeCount: z.number().int().nonnegative(),
  /** The trigger's `limits.wakesPerTicket`; null once the trigger is gone. */
  wakeLimit: z.number().int().positive().nullable(),
  /**
   * The work thread, only for a viewer who may open it. Anyone else sees the
   * chip without a link: a ticket reader outside the thread's channel is told
   * what the work is doing, never handed a door that refuses them.
   */
  thread: z.object({ id: ThreadIdSchema, channelId: ChannelIdSchema }).nullable(),
})
export type TicketWorkChipRecord = z.infer<typeof TicketWorkChipRecordSchema>

/**
 * The skip a ticket's reader should know about: a move into a start-work
 * column that started nothing, and why (`TICKET_TRIGGER_SKIP_SENTENCES`). Only
 * one that is newer than every record the same trigger holds for the ticket,
 * so a later start replaces it.
 */
export const TicketWorkSkipNoticeSchema = z.object({
  triggerId: uuid,
  agentName: z.string(),
  reason: TicketTriggerSkipReasonSchema,
  at: TimestampSchema,
})
export type TicketWorkSkipNotice = z.infer<typeof TicketWorkSkipNoticeSchema>

/** `GET /api/tasks/:taskId/work`. */
export const TaskTicketWorkRecordSchema = z.object({
  /** The newest record of each trigger, live ones first. */
  records: z.array(TicketWorkChipRecordSchema),
  lastSkip: TicketWorkSkipNoticeSchema.nullable(),
})
export type TaskTicketWorkRecord = z.infer<typeof TaskTicketWorkRecordSchema>

/**
 * The skip reasons a ticket reader is told about: a move that looked like it
 * should start work and did not. Every other skip is bookkeeping the Triggers
 * page shows its owner.
 */
export const TICKET_WORK_NOTICE_SKIP_REASONS = [
  'agent_origin',
  'token_origin',
  'source_origin',
  'system_origin',
  'not_board_editor',
  'limit_starts',
] as const satisfies readonly z.infer<typeof TicketTriggerSkipReasonSchema>[]

/** A board card's compact work state: the agent's avatar and a state dot. */
export const TicketWorkCardRecordSchema = z.object({
  taskId: TaskIdSchema,
  agentId: AgentIdSchema,
  agentName: z.string(),
  status: TicketWorkStatusSchema,
  stateReason: TicketWorkStateReasonSchema.nullable(),
})
export type TicketWorkCardRecord = z.infer<typeof TicketWorkCardRecordSchema>

/** A column that starts work, and whose. */
export const TicketWorkPickupColumnSchema = z.object({
  columnId: uuid,
  triggerId: uuid,
  agentId: AgentIdSchema,
  agentName: z.string(),
})
export type TicketWorkPickupColumn = z.infer<typeof TicketWorkPickupColumnSchema>

/** `GET /api/projects/:projectId/boards/:boardId/ticket-work`. */
export const BoardTicketWorkRecordSchema = z.object({
  /** Every column an enabled, active ticket trigger starts work from. */
  pickups: z.array(TicketWorkPickupColumnSchema),
  /** The board's cards whose newest work is live, or stopped at a limit. */
  cards: z.array(TicketWorkCardRecordSchema),
  /**
   * Whether the viewer may create a trigger — the Triggers routes' own gate,
   * decided on the server — so the column menu offers "Start work with an
   * agent…" only to people it would not refuse.
   */
  viewerCanCreateTriggers: z.boolean(),
})
export type BoardTicketWorkRecord = z.infer<typeof BoardTicketWorkRecordSchema>

/**
 * `GET /api/threads/:threadId/ticket-work`: whether a thread is a ticket's
 * work thread, and whether the viewer may write in it. Null data means an
 * ordinary thread.
 */
export const TicketWorkThreadGateSchema = z.object({
  taskId: TaskIdSchema,
  projectId: uuid,
  taskTitle: z.string(),
  /** Asked live: only people who can edit the ticket's board write here. */
  viewerCanPost: z.boolean(),
})
export type TicketWorkThreadGate = z.infer<typeof TicketWorkThreadGateSchema>

/**
 * A conversation that is a ticket's work thread, named on the conversation
 * record from the thread's own metadata, so the conversation list can fold
 * ticket threads under their agent instead of flooding it.
 */
export const TicketWorkThreadRefSchema = z.object({ taskId: TaskIdSchema })
export type TicketWorkThreadRef = z.infer<typeof TicketWorkThreadRefSchema>

/** `{ taskId, triggerId }` on `Thread.metadata`, as `ensureTicketWorkThread` writes it. */
export const ticketWorkThreadRefOf = (metadata: unknown): TicketWorkThreadRef | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const { taskId, triggerId } = metadata as Record<string, unknown>
  if (typeof triggerId !== 'string') return null
  const parsed = TicketWorkThreadRefSchema.safeParse({ taskId })
  return parsed.success ? parsed.data : null
}
