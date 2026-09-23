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
 * never claims a start or a wake that did not commit.
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
  id: string
  eventType: string
  createdAt: Date
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
   * the wake is only for the agent to comment, and binds no machine.
   */
  machineLess: boolean
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

/** Thrown by the placeholder below; the dispatcher records it as a failed delivery. */
export class TicketWorkNotImplementedError extends Error {
  constructor(operation: 'startTicketWork' | 'wakeTicketWork') {
    super(`${operation} is not implemented yet: ticket work records and ticket.work runs are not built.`)
    this.name = 'TicketWorkNotImplementedError'
  }
}

/**
 * The seam as the worker wires it until the work record, its thread and the
 * `ticket.work` run land (the next part of T1). It is unreachable in
 * production meanwhile — `ticket_changed` is still in
 * `UNRELEASED_TRIGGER_TYPES`, so no trigger exists to dispatch to — and if a
 * row were ever inserted behind the refusal, each decision would be recorded
 * as a failed delivery naming this, never silently dropped.
 */
export const notImplementedTicketWorkSeam: TicketWorkSeam = {
  startTicketWork: async () => {
    throw new TicketWorkNotImplementedError('startTicketWork')
  },
  wakeTicketWork: async () => {
    throw new TicketWorkNotImplementedError('wakeTicketWork')
  },
}
