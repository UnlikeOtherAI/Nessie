import { z } from 'zod'

import { AgentIdSchema, ChannelIdSchema, TaskIdSchema, ThreadIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'
import { TICKET_WORK_ACTIVITY_EVENT_TYPES } from './task-events.js'
import { TicketTriggerSkipReasonSchema } from './ticket-triggers.js'
import {
  StandingPolicyBindRefusalReasonSchema,
  TICKET_WORK_LIVE_STATUSES,
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
  /** Its place in the machine queue while `queued` (T4); absent or null otherwise. */
  queuePosition: z.number().int().positive().nullable().optional(),
  /**
   * While the work waits for its own machine to reconnect (`machine_offline`,
   * T5): when that machine was last heard from. The machine is never named;
   * the time is what "paused: machine offline since 14:32" says.
   */
  machineOfflineSince: TimestampSchema.nullable().optional(),
  /**
   * Why its latest wake ran with no machine, when the standing-policy binder
   * refused it (T4): the reason and the sentence the run was told, which
   * never names the machine. Null once a later wake came.
   */
  machineRefusal: z.object({
    at: TimestampSchema,
    reason: StandingPolicyBindRefusalReasonSchema,
    sentence: z.string().min(1),
  }).strict().nullable().optional(),
  /**
   * The `check_back_in` the agent set for this work, while it is live: when it
   * fires and the agent's own note. The ticket's readers see it, as they see
   * the agent's comments.
   */
  pendingReminder: z.object({ id: uuid, dueAt: TimestampSchema, note: z.string() }).nullable(),
  /** While the agent's latest comment waits for a person's answer, and since when. */
  awaitingAnswerAt: TimestampSchema.nullable(),
})
export type TicketWorkChipRecord = z.infer<typeof TicketWorkChipRecordSchema>

/**
 * The skip a ticket's reader should know about: a move into a start-work
 * column that started nothing, or moved parked work back without resuming
 * it, and why (`ticketTriggerSkipSentence`). Only one that is newer than
 * every record the same trigger holds for the ticket, so a later start
 * replaces it.
 */
export const TicketWorkSkipNoticeSchema = z.object({
  triggerId: uuid,
  agentName: z.string(),
  reason: TicketTriggerSkipReasonSchema,
  /** The move refused was a re-entry: the work exists, parked, and did not resume. */
  reentry: z.boolean(),
  at: TimestampSchema,
})
export type TicketWorkSkipNotice = z.infer<typeof TicketWorkSkipNoticeSchema>

/**
 * One row of the ticket's work history — a `work_*` activity row, as the
 * chip's history lists it: which agent, what happened to its work and why,
 * and who caused it. Nothing here is ticket text or a machine.
 */
export const TicketWorkHistoryEntrySchema = z.object({
  id: uuid,
  eventType: z.enum(TICKET_WORK_ACTIVITY_EVENT_TYPES),
  agentName: z.string(),
  status: TicketWorkStatusSchema,
  reason: TicketWorkStateReasonSchema.nullable(),
  /** Why it was where it left, when the row says (T5): `machine_offline`, its machine back or gone too long. */
  previousReason: TicketWorkStateReasonSchema.nullable().optional(),
  /** Who caused it, by name: a person, an agent; null when the platform acted on its own. */
  byName: z.string().nullable(),
  at: TimestampSchema,
})
export type TicketWorkHistoryEntry = z.infer<typeof TicketWorkHistoryEntrySchema>

/** Why the cancel route refused a viewer who cannot edit the ticket's board (403). */
export const TICKET_WORK_REMINDER_READ_ONLY_SENTENCE =
  'Only people who can edit this board can cancel the agent\'s reminder. Comment on the ticket instead.'

/** `GET /api/tasks/:taskId/work`. */
export const TaskTicketWorkRecordSchema = z.object({
  /** The newest record of each trigger, live ones first. */
  records: z.array(TicketWorkChipRecordSchema),
  lastSkip: TicketWorkSkipNoticeSchema.nullable(),
  /** The ticket's `work_*` activity, newest first and bounded. */
  history: z.array(TicketWorkHistoryEntrySchema),
  /**
   * Whether the viewer can edit the ticket's board: who may cancel a pending
   * reminder (`DELETE /api/tasks/:taskId/work/reminders/:reminderId` asks the
   * same rule).
   */
  viewerCanEditBoard: z.boolean(),
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
  'trigger_failed',
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
 * What a board editor's message in a work thread does: it `wakes` the work,
 * or wakes nobody for one of the skip reasons a thread message can have.
 */
export const TicketWorkThreadMessageOutcomeSchema = z.enum([
  'wakes',
  'work_ended',
  'trigger_disabled',
  'config_invalid',
  'not_followed',
])
export type TicketWorkThreadMessageOutcome = z.infer<typeof TicketWorkThreadMessageOutcomeSchema>

/**
 * The rule itself, over the thread's newest record and its trigger: the
 * worker's dispatcher decides a message by it and the composer says it before
 * a message is sent, so the two can never disagree. `followKinds` is null
 * when the trigger's stored configuration no longer parses.
 */
export const ticketWorkThreadMessageOutcome = (input: {
  workStatus: string
  trigger: { enabled: boolean; status: string }
  followKinds: readonly string[] | null
}): TicketWorkThreadMessageOutcome => {
  if (!(TICKET_WORK_LIVE_STATUSES as readonly string[]).includes(input.workStatus)) return 'work_ended'
  if (!input.trigger.enabled || input.trigger.status !== 'active') return 'trigger_disabled'
  if (!input.followKinds) return 'config_invalid'
  return input.followKinds.includes('thread_message') ? 'wakes' : 'not_followed'
}

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
  /**
   * Whether a message here reaches the agent — `wakes` while the work is live
   * and its trigger follows thread messages — or why not, which the composer
   * says before anyone sends one (`TICKET_TRIGGER_SKIP_SENTENCES`).
   */
  messageOutcome: TicketWorkThreadMessageOutcomeSchema,
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
