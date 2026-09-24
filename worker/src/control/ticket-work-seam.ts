import type { Prisma } from '@prisma/client'
import type {
  TicketChangedStoredConfig,
  TicketTriggerSkipReason,
  TicketWorkWakeReason,
} from '@nessie/schemas'

/**
 * Where the ticket dispatcher hands a decision to the work record.
 *
 * `trigger.ticket.dispatch` decides, per trigger, whether an event starts,
 * resumes, wakes or ends an agent's work on a ticket
 * (`ticket-trigger-dispatch.ts`); what that *does* — the work record, its
 * thread, the `ticket.work` run acting as the agent — lives behind this seam
 * (docs/plans/2026-09-23-ticket-driven-agents/ticket-work.md). Both calls run
 * inside the dispatcher's transaction, beside the delivery row, so a delivery
 * never claims a start or a wake that did not commit. The worker wires
 * `createTicketWorkSeam` (`ticket-work.ts`); a test may pass a recorder.
 *
 * A call that cannot act for a reason a person should see returns `refused`
 * with a reason from the dispatcher's closed vocabulary, and the delivery is
 * written `skipped` with it. Anything unexpected throws: the transaction rolls
 * back, and the dispatcher records a failed, retryable delivery.
 */
export type TicketWorkTrigger = {
  id: string
  agentId: string
  organizationId: string
  targetChannelId: string | null
  config: TicketChangedStoredConfig
}

export type TicketWorkEvent = {
  /**
   * The `TaskEvent`'s id, the message's for a thread message, or the version
   * a document change brought the agent up to.
   */
  id: string
  eventType: string
  createdAt: Date
  /**
   * A person's message in the work thread, or an edit to one of the ticket's
   * documents (`document_changed`), rather than a `TaskEvent`.
   */
  kind?: 'thread_message' | 'document'
  /**
   * A document change as its dispatcher already told it: metadata only, the
   * document named by title only where every reader of the channel may read
   * it (docs/standards/document-triggers.md). Set exactly when `kind` is `document`.
   */
  described?: { text: string; summary: string }
  /** The event's `TaskEvent.by`: who a resume or an end it causes names. */
  by?: string | null
}

export type TicketWorkStartInput = {
  trigger: TicketWorkTrigger
  task: { id: string; projectId: string }
  event: TicketWorkEvent
  /** The person whose own move or create started the work. */
  startedByUserId: string
  deliveryId: string
}

export type TicketWorkWakeInput = {
  trigger: TicketWorkTrigger
  task: { id: string; projectId: string }
  event: TicketWorkEvent
  workId: string
  reason: TicketWorkWakeReason
  /**
   * The event came from a board source the trigger opted in to: its text
   * reaches the agent quoted, attributed and marked untrusted.
   */
  untrusted: boolean
  /**
   * The ticket entered an end column and teardown already ran in the move:
   * the wake is only for the agent to comment, and binds no machine. Sent
   * only while the ticket still sits in an end column.
   */
  machineLess: boolean
  /**
   * A person moved the ticket back into a start-work column: a parked record
   * resumes, while the ticket is still there. Any other wake leaves the
   * record's status as it is.
   */
  resumes: boolean
  deliveryId: string
}

export type TicketWorkSeamOutcome =
  | { outcome: 'started' | 'woken'; workId: string }
  | { outcome: 'refused'; reason: TicketTriggerSkipReason }

export type TicketWorkSeam = {
  startTicketWork: (
    tx: Prisma.TransactionClient,
    input: TicketWorkStartInput,
  ) => Promise<TicketWorkSeamOutcome>
  wakeTicketWork: (
    tx: Prisma.TransactionClient,
    input: TicketWorkWakeInput,
  ) => Promise<TicketWorkSeamOutcome>
}
