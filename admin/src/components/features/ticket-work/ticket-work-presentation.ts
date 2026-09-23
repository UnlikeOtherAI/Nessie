import {
  TICKET_TRIGGER_SKIP_SENTENCES,
  TICKET_WORK_LIVE_STATUSES,
  TicketTriggerDeliveryPayloadSchema,
  type TicketTriggerSkipReason,
  type TicketWorkChipRecord,
  type TicketWorkStateReason,
  type TicketWorkStatus,
  type TicketWorkWakeReason,
} from '@nessie/schemas'

/**
 * How ticket work reads to the people on a project
 * (docs/standards/ticket-work.md → "What the project sees"): the chip in the
 * ticket dialog, the dot on a board card and a trigger's delivery rows all say
 * the same state in the same words. None of it names a machine.
 */

const LIVE = new Set<string>(TICKET_WORK_LIVE_STATUSES)

export const isLiveTicketWork = (status: TicketWorkStatus): boolean => LIVE.has(status)

/** The state word the chip leads with. */
export const TICKET_WORK_STATUS_LABEL: Record<TicketWorkStatus, string> = {
  queued: 'queued',
  active: 'working',
  parked: 'parked',
  waiting_machine: 'waiting for a machine',
  done: 'done',
  cancelled: 'ended',
  failed: 'stopped',
}

/** The dot's colour, from the same tokens the rest of the admin's state dots use. */
export const TICKET_WORK_STATUS_DOT: Record<TicketWorkStatus, string> = {
  queued: 'var(--warning-text)',
  active: 'var(--success-text)',
  parked: 'var(--info-text)',
  waiting_machine: 'var(--warning-text)',
  done: 'var(--tx3)',
  cancelled: 'var(--tx3)',
  failed: 'var(--danger-text)',
}

/** Why the work is where it is, in the chip's second breath. */
export const TICKET_WORK_STATE_REASON_LABEL: Record<TicketWorkStateReason, string> = {
  queued_no_free_machine: 'every machine is busy',
  queued_machines_offline: 'the machines are offline',
  machine_access_not_set_up: 'waiting for machine access',
  machine_access_suspended: 'machine access is paused',
  machine_access_ended: 'machine access ended',
  machine_offline: 'the machine is offline',
  limit_wakes: 'its wakes are used up',
  limit_hours: 'its hours are used up',
  limit_cost: 'its budget is used up',
  limit_daily: 'the trigger started as many tickets today as it may',
  left_flow: 'the ticket left the flow',
  merged: 'merged',
  mover_lost_access: 'the person who started it lost access',
  trigger_disabled: 'its trigger was turned off',
  identity_unverifiable: 'its identity could not be verified',
}

/** "Woken: …" — what a wake was for, as the chip and the delivery rows say it. */
export const TICKET_WAKE_REASON_LABEL: Record<TicketWorkWakeReason, string> = {
  pickup: 'work started',
  dequeued: 'its turn came',
  queued: 'queued',
  ticket_commented: 'a comment',
  ticket_description_changed: 'an edited description',
  ticket_priority_changed: 'a changed priority',
  ticket_labels_changed: 'changed labels',
  ticket_assignee_changed: 'a changed assignee',
  ticket_moved: 'a move',
  thread_message: 'a message in its work thread',
  document_changed: 'an edited document',
  session_turn_ended: 'a coding session’s turn ended',
  session_interrupted: 'a coding session was interrupted',
  session_failed: 'a coding session failed',
  session_closed: 'a coding session closed',
  reminder: 'a reminder',
  quiet: 'nothing else was scheduled',
  machine_back_online: 'the machine came back',
}

const clock = (value: string): string =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const day = (value: string): string => {
  const date = new Date(value)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? clock(value)
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(value)}`
}

/** "CTO · working · started 14:05" */
export const ticketWorkHeadline = (record: TicketWorkChipRecord): string =>
  [record.agent.name, TICKET_WORK_STATUS_LABEL[record.status], `started ${day(record.startedAt)}`].join(' · ')

/**
 * The line under the headline: why it stopped, or why it waits. A limit reads
 * as the plan's "stopped: 30 wakes used"; the remedy is the chip's own line.
 */
export const ticketWorkStateLine = (record: TicketWorkChipRecord): string | null => {
  if (record.stateReason === 'limit_wakes') {
    return `Stopped: ${record.wakeCount} wakes used. Move the ticket out of and back into a start-work column to continue.`
  }
  if (record.stateReason === 'limit_daily') {
    return 'Stopped: the trigger started as many tickets today as it may. Move the ticket out of and back into a start-work column to try again.'
  }
  if (record.status === 'parked') return 'Parked while the ticket is in review. Moving it back into a start-work column resumes it.'
  if (!record.stateReason) return null
  const reason = TICKET_WORK_STATE_REASON_LABEL[record.stateReason]
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${record.endedAt ? ` · ${day(record.endedAt)}` : ''}.`
}

/** "Last woken 14:32 by a comment · wake 3 of 30" */
export const ticketWorkWakeLine = (record: TicketWorkChipRecord): string | null => {
  if (!record.lastWakeAt || !record.lastWakeReason) return null
  const count = record.wakeLimit ? ` · wake ${record.wakeCount} of ${record.wakeLimit}` : ''
  return `Last woken ${day(record.lastWakeAt)}: ${TICKET_WAKE_REASON_LABEL[record.lastWakeReason]}${count}`
}

export const ticketSkipSentence = (reason: TicketTriggerSkipReason): string => TICKET_TRIGGER_SKIP_SENTENCES[reason]

/**
 * A ticket delivery on a trigger's page: what the dispatcher did with one
 * event, in words. Null for any other trigger's payload, which keeps its raw
 * payload view.
 */
export const ticketDeliveryLine = (payload: unknown): string | null => {
  const parsed = TicketTriggerDeliveryPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const delivery = parsed.data
  if (delivery.outcome === 'skipped' && delivery.skipReason) return ticketSkipSentence(delivery.skipReason)
  const reason = delivery.wakeReason ? TICKET_WAKE_REASON_LABEL[delivery.wakeReason] : null
  switch (delivery.outcome) {
    case 'pickup':
      return 'Started work on the ticket.'
    case 'reentry':
      return 'The ticket came back into a start-work column: woke its work.'
    case 'end':
      return 'The ticket entered an end column: its work ended, and the agent was told.'
    default:
      return `Woke the agent: ${reason ?? 'a change'}${delivery.untrusted ? ', marked untrusted' : ''}.`
  }
}
