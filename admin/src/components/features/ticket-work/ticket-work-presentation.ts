import {
  standingPolicyRefusalSentence,
  TICKET_WORK_LIVE_STATUSES,
  TicketTriggerBindingRefusalPayloadSchema,
  TicketTriggerDeliveryPayloadSchema,
  ticketTriggerSkipSentence,
  type TicketTriggerSkipReason,
  type TicketWorkChipRecord,
  type TicketWorkHistoryEntry,
  type TicketWorkSkipNotice,
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
 * A refused move back that left this record parked, if the ticket's newest
 * skip is one: the ticket then sits in a start-work column while its work
 * waits, and "moving it back resumes it" would be false for everyone reading.
 */
export const refusedReentryOf = (
  record: TicketWorkChipRecord,
  lastSkip: TicketWorkSkipNotice | null,
): TicketWorkSkipNotice | null =>
  record.status === 'parked' && lastSkip?.reentry && lastSkip.triggerId === record.triggerId ? lastSkip : null

/** How a stopped record starts again: the same move for every per-ticket limit. */
const LIMIT_REMEDY = 'Move the ticket out of and back into a start-work column to continue.'

/**
 * Live work that waits for a machine, in the chip's words (T4): its place in
 * the queue and why, the machine it holds gone offline, or machine access its
 * owner has not set up or has paused. None names the machine.
 */
const machineWaitLine = (record: TicketWorkChipRecord): string | null => {
  if (record.status === 'queued') {
    const why = record.stateReason === 'queued_no_free_machine' || record.stateReason === 'queued_machines_offline'
      ? TICKET_WORK_STATE_REASON_LABEL[record.stateReason]
      : null
    if (record.queuePosition) return `Queued: position ${record.queuePosition}${why ? ` — ${why}` : ''}.`
    return why ? `Queued: ${why}.` : 'Queued for a machine.'
  }
  if (record.status !== 'waiting_machine') return null
  switch (record.stateReason) {
    case 'machine_offline':
      return `Paused: the machine is offline${record.machineOfflineSince ? ` since ${day(record.machineOfflineSince)}` : ''}. `
        + 'Work resumes when it reconnects.'
    case 'machine_access_not_set_up': return 'Waiting for machine access: its owner has not set it up yet.'
    case 'machine_access_suspended':
      return 'Waiting for machine access: it is paused until its owner confirms it again.'
    default: return null
  }
}

/**
 * The line under the headline: why it stopped, or why it waits. A limit reads
 * as the plan's "stopped: 30 wakes used"; the remedy is the chip's own line.
 */
export const ticketWorkStateLine = (
  record: TicketWorkChipRecord,
  lastSkip: TicketWorkSkipNotice | null = null,
): string | null => {
  if (record.stateReason === 'limit_wakes') return `Stopped: ${record.wakeCount} wakes used. ${LIMIT_REMEDY}`
  if (record.stateReason === 'limit_hours') return `Stopped: its hours are used up. ${LIMIT_REMEDY}`
  if (record.stateReason === 'limit_cost') return `Stopped: its budget is used up. ${LIMIT_REMEDY}`
  if (record.stateReason === 'limit_daily') {
    return 'Stopped: the trigger started as many tickets today as it may. Move the ticket out of and back into a start-work column to try again.'
  }
  if (record.stateReason === 'machine_access_ended' && !isLiveTicketWork(record.status)) {
    return 'Ended: its machine access ended.'
  }
  const refused = refusedReentryOf(record, lastSkip)
  if (refused) return ticketSkipSentence(refused.reason, { reentry: true })
  if (record.status === 'parked') return 'Parked while the ticket is in review. Moving it back into a start-work column resumes it.'
  const waiting = machineWaitLine(record)
  if (waiting) return waiting
  if (!record.stateReason) return null
  const reason = TICKET_WORK_STATE_REASON_LABEL[record.stateReason]
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${record.endedAt ? ` · ${day(record.endedAt)}` : ''}.`
}

/**
 * "Ran without a machine: …" — why the latest wake of live work ran with no
 * machine, in the finished sentence the run itself was told. The server drops
 * it once a later wake comes, and ended work never shows it.
 */
export const ticketWorkMachineRefusalLine = (record: TicketWorkChipRecord): string | null =>
  record.machineRefusal && isLiveTicketWork(record.status) ? record.machineRefusal.sentence : null

/** What live work that waits for a machine waits on, for a history row. */
const machineWaitPhrase = (reason: TicketWorkStateReason | null): string =>
  reason === 'machine_offline' ? 'the machine to reconnect' : 'machine access'

/** What one `work_*` row says happened, and why, from its event, status and reason. */
const historyPhrase = (entry: TicketWorkHistoryEntry): string => {
  const why = entry.reason ? TICKET_WORK_STATE_REASON_LABEL[entry.reason] : null
  switch (entry.eventType) {
    case 'work_started':
      if (entry.status === 'queued') return 'started work, queued for a machine'
      return entry.status === 'waiting_machine'
        ? `started work, waiting for ${machineWaitPhrase(entry.reason)}`
        : 'started work'
    case 'work_queued':
      // Taken off a machine that stayed away too long, for another one to take (T5).
      if (entry.previousReason === 'machine_offline') {
        return `queued the work for another machine, because its machine stayed offline${why ? `: ${why}` : ''}`
      }
      return why ? `queued the work: ${why}` : 'queued the work for a machine'
    // A pause with no reason is the park in review; one with a reason waits for a machine.
    case 'work_paused':
      return why ? `paused the work: ${why}` : 'parked the work while the ticket is in review'
    case 'work_resumed':
      if (entry.previousReason === 'machine_offline') return 'resumed the work: its machine is back online'
      if (entry.status === 'queued') return 'resumed the work, which is queued for a machine'
      return entry.status === 'waiting_machine'
        ? `resumed the work, which waits for ${machineWaitPhrase(entry.reason)}`
        : 'resumed the work'
    case 'work_ended':
      return why ? `ended the work: ${why}` : 'ended the work'
  }
}

/** "14:05 · Perf agent started work · by Ondrej" — one row of the chip's history. */
export const ticketWorkHistoryLine = (entry: TicketWorkHistoryEntry): string => [
  day(entry.at),
  `${entry.agentName} ${historyPhrase(entry)}`,
  ...(entry.byName ? [`by ${entry.byName}`] : []),
].join(' · ')

/** "Last woken 14:32 by a comment · wake 3 of 30" */
export const ticketWorkWakeLine = (record: TicketWorkChipRecord): string | null => {
  if (!record.lastWakeAt || !record.lastWakeReason) return null
  const count = record.wakeLimit ? ` · wake ${record.wakeCount} of ${record.wakeLimit}` : ''
  return `Last woken ${day(record.lastWakeAt)}: ${TICKET_WAKE_REASON_LABEL[record.lastWakeReason]}${count}`
}

export const ticketSkipSentence = (reason: TicketTriggerSkipReason, options: { reentry?: boolean } = {}): string =>
  ticketTriggerSkipSentence(reason, options)

/**
 * A ticket delivery on a trigger's page: what the dispatcher did with one
 * event, in words. Null for any other trigger's payload, which keeps its raw
 * payload view.
 */
export const ticketDeliveryLine = (payload: unknown): string | null => {
  // The standing-policy binder bound no machine to one run: the run went on
  // without one, and the page says why in the same words the chip does.
  const refusal = TicketTriggerBindingRefusalPayloadSchema.safeParse(payload)
  if (refusal.success) return standingPolicyRefusalSentence(refusal.data.reason)
  const parsed = TicketTriggerDeliveryPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const delivery = parsed.data
  // A coding session's turn the agent had already read, or that ended while its work was not active (T5).
  if (delivery.outcome === 'skipped' && delivery.session && delivery.skipReason === 'no_longer_applies') {
    return 'A coding session\'s turn ended, but the agent had already read it or the work was not active, so it was '
      + 'not woken for it.'
  }
  if (delivery.outcome === 'skipped' && delivery.skipReason) {
    return ticketSkipSentence(delivery.skipReason, { reentry: delivery.reentry === true })
  }
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

/** "Checking back at 14:35 — waiting for CI": the agent's pending `check_back_in`. */
export const ticketWorkReminderLine = (record: TicketWorkChipRecord): string | null =>
  record.pendingReminder ? `Checking back at ${day(record.pendingReminder.dueAt)} — ${record.pendingReminder.note}` : null

/**
 * "Waiting for an answer on the ticket since 14:20": the agent's latest
 * comment asked the people on the ticket something. Until one of them
 * answers, nothing wakes the work just because it is quiet.
 */
export const ticketWorkQuestionLine = (record: TicketWorkChipRecord): string | null =>
  record.awaitingAnswerAt ? `Waiting for an answer on the ticket since ${day(record.awaitingAnswerAt)}` : null
