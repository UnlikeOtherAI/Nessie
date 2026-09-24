import { z } from 'zod'

import { TicketWorkStateReasonSchema, TicketWorkWakeReasonSchema } from './ticket-work.js'

/**
 * What a ticket's work thread carries beside ordinary messages
 * (docs/standards/ticket-work.md → "The work thread"). Each is a key of
 * `Message.metadata` the platform stamps from structural facts, never from a
 * client body, so no request can forge one.
 */
const uuid = z.string().uuid()

/**
 * A person's own message in a work thread. It starts no ordinary run: it wakes
 * the thread's work record as a `thread_message` follow, and a `ticket.work`
 * run's conversation admits it beside the agent's own replies. Only people
 * who can edit the ticket's board may post there, so every stamped message is
 * a board editor's.
 */
export const TICKET_WORK_STEER_METADATA_KEY = 'ticketWorkSteer'

/**
 * `Message.metadata.ticketWorkEvent`: one compact row in the work thread for
 * each thing that happened to the work — why the agent was woken, or why the
 * platform stopped it. It is a `system` message the thread feed admits as an
 * event row; its `summary` is all it shows, and it never repeats ticket text,
 * because the channel can be wider than the project the ticket belongs to.
 */
export const TicketWorkThreadEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('woken'),
    workId: uuid,
    reason: TicketWorkWakeReasonSchema,
    summary: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('stopped'),
    workId: uuid,
    reason: TicketWorkStateReasonSchema,
    summary: z.string().min(1),
  }).strict(),
  // A document trigger woke its agent in a document's own review thread
  // (docs/standards/document-triggers.md): no work record, the same row.
  z.object({
    kind: z.literal('document_woken'),
    triggerId: uuid,
    reason: z.literal('document_changed'),
    summary: z.string().min(1),
  }).strict(),
])
export type TicketWorkThreadEvent = z.infer<typeof TicketWorkThreadEventSchema>

/**
 * `Message.metadata.ticketWorkKickoff` on a `ticket.work` kickoff: the events
 * it tells the agent about, in order. A wake for a record whose kickoff is
 * still pending folds into it — its event is appended here and the kickoff is
 * rebuilt from the record — so one run hears about every change since the
 * last, and counts once against the trigger's wake limit.
 */
export const TicketWorkKickoffEventSchema = z.object({
  reason: TicketWorkWakeReasonSchema,
  at: z.string().datetime(),
  /** The event as the kickoff tells it: one line, then any quoted text. */
  text: z.string().min(1),
}).strict()
export type TicketWorkKickoffEvent = z.infer<typeof TicketWorkKickoffEventSchema>

export const TicketWorkKickoffMetadataSchema = z.object({
  workId: uuid,
  events: z.array(TicketWorkKickoffEventSchema).min(1),
  /**
   * The wake this kickoff counted as. The kickoff is rendered again when its
   * run starts, from the record as it is then, and a later wake may already
   * have counted the next one.
   */
  wakeNumber: z.number().int().positive().optional(),
  /**
   * The ticket's description as this kickoff left the agent knowing it: set
   * by a kickoff that starts the work or tells it of a description change, so
   * the next change is shown as a line diff against what the agent last saw
   * rather than as the whole text again. It lives only on the kickoff — a
   * hidden `system` message of the work thread, which already quotes a
   * changed description — never in the ticket's history. `text` is null for
   * a ticket with no description.
   */
  detailSeen: z.object({ text: z.string().nullable() }).strict().optional(),
}).strict()
export type TicketWorkKickoffMetadata = z.infer<typeof TicketWorkKickoffMetadataSchema>
