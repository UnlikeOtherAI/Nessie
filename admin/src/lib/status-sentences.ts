import type {
  AgentStatus,
  AgentTriggerStatus,
  ExecutorCodingSessionStatus,
  ExecutorStatus,
} from '@nessie/schemas'
import type { AgentTriggerDeliveryRecord } from './api-client'

/**
 * Every raw status enum the admin shows, said as words a person acts on
 * (docs/plans/2026-09-26-admin-ux-overhaul.md, R5 and §6.9).
 *
 * A page used to print the server's value: a trigger row read
 * `needs_reauthorization`, an app install `pending_setup`, a coding session
 * `waiting_for_input`. Each of those names a state and says nothing about what
 * to do. Here every state has a short `label` for a pill or a dot, a whole
 * `sentence` that carries the remedy where there is one, and the `tone` the
 * pill is drawn in. One module, so two pages cannot word the same state two
 * ways, and a value this module does not know reads as a plain "could not be
 * read" rather than leaking the enum onto the screen.
 *
 * Anything *connected* — an account, an app install, a sign-in — speaks in the
 * plan's five words ({@link CONNECTION_STATUS_WORDS}). Agents, schedules,
 * computers and sessions have states of their own, still in plain words.
 */

/** The five words everything connected is described in (plan §6.9). */
export const CONNECTION_STATUS_WORDS = [
  'Connected',
  'Needs attention',
  'Turned off',
  'Not finished',
  'Error',
] as const
export type ConnectionStatusWord = (typeof CONNECTION_STATUS_WORDS)[number]

/** The pill tones a status is drawn in — the same names `Pill` takes. */
export type StatusTone = 'accent' | 'danger' | 'info' | 'muted' | 'success' | 'warning'

export type StatusSentence = {
  /** A few words for a pill, a dot's label or a table cell. */
  label: string
  /** The whole sentence, ending in the remedy when there is one. */
  sentence: string
  tone: StatusTone
}

const UNKNOWN: StatusSentence = {
  label: 'Unknown',
  sentence: 'Its state could not be read. Refresh the page to try again.',
  tone: 'muted',
}

const known = <T extends string>(table: Record<T, StatusSentence>, value: string): StatusSentence =>
  Object.prototype.hasOwnProperty.call(table, value) ? table[value as T] : UNKNOWN

// ─── Agents ─────────────────────────────────────────────────────────────────

const AGENT: Record<AgentStatus, StatusSentence> = {
  error: {
    label: 'Error',
    sentence: 'Its last run failed. The reason is under Activity.',
    tone: 'danger',
  },
  executing: { label: 'Working', sentence: 'Working on a request right now.', tone: 'accent' },
  idle: { label: 'Idle', sentence: 'Idle and ready for its next request.', tone: 'muted' },
  offline: {
    label: 'Offline',
    sentence: 'Offline, so it cannot start new work right now.',
    tone: 'muted',
  },
  thinking: { label: 'Thinking', sentence: 'Thinking about its next step.', tone: 'accent' },
  waiting_approval: {
    label: 'Waiting for approval',
    sentence: 'Waiting for someone to approve a step in its conversation.',
    tone: 'warning',
  },
  waiting_input: {
    label: 'Waiting for an answer',
    sentence: 'Waiting for someone to answer its question in the conversation.',
    tone: 'warning',
  },
}

export const agentStatusSentence = (status: AgentStatus | string): StatusSentence =>
  known(AGENT, status)

// ─── Schedules and triggers ─────────────────────────────────────────────────

const TRIGGER: Record<AgentTriggerStatus, StatusSentence> = {
  active: { label: 'On', sentence: 'On: it runs whenever it is due.', tone: 'success' },
  error: {
    label: 'Error',
    sentence: 'Error: it has stopped running. Open it to see why.',
    tone: 'danger',
  },
  needs_reauthorization: {
    label: 'Needs attention',
    sentence: 'Needs attention: reauthorize it to run again.',
    tone: 'warning',
  },
  paused: {
    label: 'Turned off',
    sentence: 'Turned off: resume it to run again.',
    tone: 'warning',
  },
}

export const triggerStatusSentence = (status: AgentTriggerStatus | string): StatusSentence =>
  known(TRIGGER, status)

// The API also answers `skipped_overlap` (a fire recorded while the previous
// run was still going), which the shared client type does not list yet.
const DELIVERY: Record<AgentTriggerDeliveryRecord['status'] | 'skipped_overlap', StatusSentence> = {
  delivered: { label: 'Delivered', sentence: 'Delivered: the run started.', tone: 'success' },
  failed: {
    label: 'Failed',
    sentence: 'Failed: the run did not start. The reason is beside it.',
    tone: 'danger',
  },
  pending: { label: 'Waiting', sentence: 'Waiting to start the run.', tone: 'warning' },
  skipped: {
    label: 'Skipped',
    sentence: 'Skipped: nothing needed to run this time.',
    tone: 'muted',
  },
  skipped_overlap: {
    label: 'Skipped',
    sentence: 'Skipped: the previous run was still going.',
    tone: 'muted',
  },
}

export const deliveryStatusSentence = (
  status: AgentTriggerDeliveryRecord['status'] | string,
): StatusSentence => known(DELIVERY, status)

// ─── Computers and their sessions ───────────────────────────────────────────

const COMPUTER: Record<ExecutorStatus, StatusSentence> = {
  draining: {
    label: 'Finishing',
    sentence: 'Finishing the work it has before it stops.',
    tone: 'warning',
  },
  error: {
    label: 'Error',
    sentence: 'Error: it reported a problem. Check it on the computer.',
    tone: 'danger',
  },
  offline: {
    label: 'Offline',
    sentence: 'Offline: work for it waits until it connects again.',
    tone: 'muted',
  },
  online: { label: 'Online', sentence: 'Online and ready for work.', tone: 'success' },
  paused: {
    label: 'Turned off',
    sentence: 'Turned off: resume it from the Computer menu.',
    tone: 'warning',
  },
  pending_pairing: {
    label: 'Not finished',
    sentence: 'Not finished: confirm the pairing on the computer.',
    tone: 'warning',
  },
  revoked: {
    label: 'Disconnected',
    sentence: 'Disconnected: pair it again to use it.',
    tone: 'danger',
  },
}

export const computerStatusSentence = (status: ExecutorStatus | string): StatusSentence =>
  known(COMPUTER, status)

const SESSION: Record<ExecutorCodingSessionStatus, StatusSentence> = {
  closed: { label: 'Closed', sentence: 'Closed.', tone: 'muted' },
  failed: { label: 'Failed', sentence: 'Failed: the session stopped with an error.', tone: 'danger' },
  interrupted: {
    label: 'Interrupted',
    sentence: 'Interrupted: the session stopped before it finished.',
    tone: 'warning',
  },
  starting: { label: 'Starting', sentence: 'Starting on the computer.', tone: 'muted' },
  waiting_for_input: {
    label: 'Waiting for input',
    sentence: 'Waiting for input in the session.',
    tone: 'info',
  },
  working: { label: 'Working', sentence: 'Working.', tone: 'accent' },
}

export const sessionStatusSentence = (status: ExecutorCodingSessionStatus | string): StatusSentence =>
  known(SESSION, status)

// ─── Anything connected ─────────────────────────────────────────────────────

/**
 * The spellings the connected things use today, each folded onto one of the
 * five words: an app install (`connecting` … `disabled`), its lifecycle
 * (`pending_setup`, `active`, `paused`), and an account's sign-in
 * (`needs_reauthorization`, `disconnected`).
 */
export type ConnectionStatusValue =
  | 'active'
  | 'connected'
  | 'connecting'
  | 'disabled'
  | 'disconnected'
  | 'error'
  | 'expired'
  | 'needs_reauthorization'
  | 'paused'
  | 'pending_setup'

const connected: StatusSentence = {
  label: 'Connected',
  sentence: 'Connected and working.',
  tone: 'success',
}
const notFinished: StatusSentence = {
  label: 'Not finished',
  sentence: 'Not finished: complete the connection to use it.',
  tone: 'accent',
}
const needsAttention: StatusSentence = {
  label: 'Needs attention',
  sentence: 'Needs attention: sign in again to reconnect it.',
  tone: 'warning',
}
const turnedOff: StatusSentence = {
  label: 'Turned off',
  sentence: 'Turned off: connect it again to use it.',
  tone: 'muted',
}
const failed: StatusSentence = {
  label: 'Error',
  sentence: 'Error: reconnect it, or check its settings.',
  tone: 'danger',
}

const CONNECTION: Record<ConnectionStatusValue, StatusSentence> = {
  active: connected,
  connected,
  connecting: notFinished,
  disabled: turnedOff,
  disconnected: turnedOff,
  error: failed,
  expired: needsAttention,
  needs_reauthorization: needsAttention,
  paused: turnedOff,
  pending_setup: notFinished,
}

export const connectionStatusSentence = (status: ConnectionStatusValue | string): StatusSentence =>
  known(CONNECTION, status)
