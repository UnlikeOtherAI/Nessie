import { z } from 'zod'

import { TicketWorkWakeReasonSchema, type TicketWorkWakeReason } from './ticket-work.js'

/**
 * What a `ticket_changed` trigger reacts to, as the dispatcher reads it
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "Dispatch", and
 * docs/standards/ticket-work.md).
 *
 * The stored configuration is the **resolved** form the server writes: the
 * board and the pickup columns by id, whatever name or category a person or
 * the Designer used to name them. The typed input union the Triggers editor
 * and `agent_trigger_create` accept extends this schema rather than defining
 * a second one, so the dispatcher and the writer can never read two shapes.
 * Unknown keys pass through: instructions, limits and the wake timings are
 * the editor's, and dispatch does not read them.
 */
const uuid = z.string().uuid()

/**
 * The kinds of ticket change that wake live work. `thread_message` and
 * `document` are not `TaskEvent`s: a person's message in the work thread and
 * a `document_changed` delivery wake through the same record by their own
 * doors.
 */
export const TicketFollowKindSchema = z.enum([
  'comment',
  'description',
  'moved',
  'thread_message',
  'document',
  'priority',
  'labels',
  'assignee',
])
export type TicketFollowKind = z.infer<typeof TicketFollowKindSchema>

/** Followed unless the trigger says otherwise; priority, labels and assignee are opt-in. */
export const DEFAULT_TICKET_FOLLOW_KINDS = [
  'comment',
  'description',
  'moved',
  'thread_message',
  'document',
] as const satisfies readonly TicketFollowKind[]

/** The wake reason each followed kind wakes with: the kickoff's first block. */
export const TICKET_FOLLOW_WAKE_REASONS = {
  comment: 'ticket_commented',
  description: 'ticket_description_changed',
  moved: 'ticket_moved',
  thread_message: 'thread_message',
  document: 'document_changed',
  priority: 'ticket_priority_changed',
  labels: 'ticket_labels_changed',
  assignee: 'ticket_assignee_changed',
} as const satisfies Record<TicketFollowKind, TicketWorkWakeReason>

/**
 * The `TaskEvent` types a `ticket_changed` trigger can act on. Only these are
 * enqueued for dispatch; every other event (attachments, checklists, run
 * lifecycle) never starts, steers or ends work.
 */
export const TICKET_TRIGGER_EVENT_TYPES = [
  'created',
  'column_entered',
  'comment_added',
  'detail_edited',
  'priority_changed',
  'labels_changed',
  'assigned',
  'unassigned',
] as const
export type TicketTriggerEventType = (typeof TICKET_TRIGGER_EVENT_TYPES)[number]

export const isTicketTriggerEventType = (value: string): value is TicketTriggerEventType =>
  (TICKET_TRIGGER_EVENT_TYPES as readonly string[]).includes(value)

/**
 * The follow kind an event is. `created` is never a follow: a ticket created
 * into a start-work column is a pickup, and anywhere else it is nothing yet.
 */
export const TICKET_EVENT_FOLLOW_KINDS = {
  created: null,
  column_entered: 'moved',
  comment_added: 'comment',
  detail_edited: 'description',
  priority_changed: 'priority',
  labels_changed: 'labels',
  assigned: 'assignee',
  unassigned: 'assignee',
} as const satisfies Record<TicketTriggerEventType, TicketFollowKind | null>

/** A column that ends the work: every column of a category, or one column. */
export const TicketEndOnSchema = z.union([
  z.object({ category: z.enum(['todo', 'done']) }).strict()
    .describe('Every column of this category ends the work.'),
  z.object({ id: uuid }).strict().describe('This one column ends the work.'),
])
export type TicketEndOn = z.infer<typeof TicketEndOnSchema>

/** By default, leaving for any todo- or done-category column ends the work. */
export const DEFAULT_TICKET_END_ON: readonly TicketEndOn[] = [
  { category: 'todo' },
  { category: 'done' },
]

export const TicketChangedStoredConfigSchema = z
  .object({
    boardId: uuid.describe('The board whose tickets this trigger reacts to.'),
    pickup: z
      .object({
        columnIds: z
          .array(uuid)
          .min(1)
          .describe('Start-work columns: a person moving a ticket into one starts work.'),
        assignOnPickup: z
          .boolean()
          .default(true)
          .describe('Assign an unassigned ticket to the agent when a person starts its work.'),
      })
      .strict()
      .nullable()
      .default(null)
      .describe('Absent: the trigger only follows work, it never starts any.'),
    follow: z
      .object({
        kinds: z
          .array(TicketFollowKindSchema)
          .default([...DEFAULT_TICKET_FOLLOW_KINDS])
          .describe('Which changes to a ticket in progress wake the agent.'),
        includeSourceEvents: z
          .boolean()
          .default(false)
          .describe(
            'Let a mirrored board\'s own changes wake live work too. They never start or resume it, '
            + 'and their text reaches the agent marked untrusted.',
          ),
      })
      .strict()
      .default({}),
    endOn: z
      .array(TicketEndOnSchema)
      .default([...DEFAULT_TICKET_END_ON])
      .describe('Columns that end the work when the ticket enters one.'),
  })
  .passthrough()
export type TicketChangedStoredConfig = z.infer<typeof TicketChangedStoredConfigSchema>

/**
 * `agent_trigger_deliveries.source` for ticket work: which door the wake came
 * through. The dispatcher writes `pickup` and `follow`; the session intake,
 * reminders, the pool dispatcher and quiet wakes write the others.
 */
export const TicketTriggerDeliverySourceSchema = z.enum([
  'pickup',
  'follow',
  'session',
  'reminder',
  'dequeue',
  'quiet',
])
export type TicketTriggerDeliverySource = z.infer<typeof TicketTriggerDeliverySourceSchema>

/** What the dispatcher did with one event for one trigger. */
export const TicketTriggerDispatchOutcomeSchema = z.enum([
  'pickup',
  // A ticket re-entering a start-work column while its work is live or parked.
  'reentry',
  'follow',
  // The ticket entered an end column; teardown already ran in the move.
  'end',
  'skipped',
])
export type TicketTriggerDispatchOutcome = z.infer<typeof TicketTriggerDispatchOutcomeSchema>

/**
 * Why an event that would have started, resumed or woken work did not. Every
 * such event writes a delivery with one of these, so "I moved it and nothing
 * happened" always has an answer on the Triggers page and the ticket.
 */
export const TicketTriggerSkipReasonSchema = z.enum([
  // The origin rule: only a person's own session starts or steers work.
  'agent_origin',
  'token_origin',
  'source_origin',
  'system_origin',
  // A person's session, but they cannot edit the board.
  'not_board_editor',
  // The trigger's own agent moved its ticket into an end column: its own
  // action wakes nothing, so it cannot loop on itself.
  'own_agent_event',
  // Moved between two start-work columns with no work on record: the ticket
  // never entered the pickup set, so nothing starts.
  'already_in_pickup_column',
  // A priority change on a queued ticket re-sorts the queue and wakes nothing.
  'priority_while_queued',
  // The stored configuration does not parse, or names no board: the trigger
  // matches nothing, and its health says so.
  'config_invalid',
  // A failed delivery, retried, whose event no longer starts or wakes
  // anything (the work ended, or the ticket moved on).
  'no_longer_applies',
])
export type TicketTriggerSkipReason = z.infer<typeof TicketTriggerSkipReasonSchema>

/**
 * The sentence a skip reads as, for the ticket and the Triggers page. The
 * origin refusals name the remedy: a person who can edit the board starts it.
 */
export const TICKET_TRIGGER_SKIP_SENTENCES = {
  agent_origin: 'Moved by an agent, so work did not start. A person who can edit the board can start it.',
  token_origin: 'Changed through an API credential, so work did not start. A person who can edit the board can start it.',
  source_origin: 'Changed on the connected board, so work did not start. A person who can edit the board can start it.',
  system_origin: 'Changed by Nessie itself, so work did not start.',
  not_board_editor: 'Changed by someone who cannot edit this board, so work did not start.',
  own_agent_event: 'The agent moved its own ticket, so it was not woken for it.',
  already_in_pickup_column: 'The ticket was already in a start-work column, so moving it between them started nothing.',
  priority_while_queued: 'The ticket is queued: its new priority re-sorts the queue and wakes nothing.',
  config_invalid: 'This trigger\'s configuration names no board or no longer parses, so it matches nothing.',
  no_longer_applies: 'By the time this was retried, it no longer started or woke any work.',
} as const satisfies Record<TicketTriggerSkipReason, string>

/** `agent_trigger_deliveries.payload` of a ticket dispatch. Ids and vocabulary only. */
export const TicketTriggerDeliveryPayloadSchema = z
  .object({
    taskEventId: uuid,
    taskId: uuid,
    eventType: z.enum(TICKET_TRIGGER_EVENT_TYPES),
    originKind: z.enum(['session', 'token', 'agent', 'source', 'system']),
    outcome: TicketTriggerDispatchOutcomeSchema,
    skipReason: TicketTriggerSkipReasonSchema.optional(),
    wakeReason: TicketWorkWakeReasonSchema.optional(),
    workId: uuid.optional(),
    // A source event woke the work: its text reaches the agent as untrusted.
    untrusted: z.boolean().optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if ((payload.outcome === 'skipped') !== (payload.skipReason !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skipReason'],
        message: 'A skipped delivery says why, and only a skipped one does.',
      })
    }
  })
export type TicketTriggerDeliveryPayload = z.infer<typeof TicketTriggerDeliveryPayloadSchema>
