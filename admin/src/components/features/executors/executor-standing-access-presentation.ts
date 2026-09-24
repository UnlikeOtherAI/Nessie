import type { ExecutorStandingPolicyRow, ExecutorStandingPolicySuspendedReason } from '@nessie/schemas'

import type { PillTone } from '../../primitives/Pill'

/**
 * How one row of an executor's Standing access panel reads
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * its state, the one sentence that says whose move it is, how many tickets
 * are working on this machine under it, and what End does. The server
 * decides all of it; these are its words for the screen.
 */

export const STANDING_ACCESS_STATE: Record<ExecutorStandingPolicyRow['status'], { label: string; tone: PillTone }> = {
  preparing: { label: 'Awaiting confirmation', tone: 'accent' },
  live: { label: 'Live', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'warning' },
  ended: { label: 'Ended', tone: 'muted' },
}

/**
 * A policy's pool may hold two machines and the row does not say which one's
 * setup moved, so the digest reason names "one of its machines", which is
 * true whichever it was.
 */
const SUSPENDED_BECAUSE: Record<ExecutorStandingPolicySuspendedReason, string> = {
  trigger_changed: 'The trigger was edited',
  descriptor_changed: 'The reviewed setup of one of its machines changed',
  agent_changed: 'The agent’s instructions, model, tools or connectors were edited',
}

type StateRow = Pick<ExecutorStandingPolicyRow, 'authorName' | 'status' | 'suspendedReason'>

/** The line under a row's state; a live or ended row needs none. */
export const standingAccessStateLine = (row: StateRow): string | null => {
  switch (row.status) {
    case 'suspended': {
      const because = row.suspendedReason ? SUSPENDED_BECAUSE[row.suspendedReason] : 'Something it relies on changed'
      return `${because}, so it waits until ${row.authorName} confirms again.`
    }
    case 'preparing':
      return `Nothing runs here until ${row.authorName} confirms it.`
    case 'live':
    case 'ended':
      return null
  }
}

/** "2 tickets working here" */
export const standingAccessTicketsLine = (count: number): string =>
  count === 0 ? 'No tickets working here' : `${count} ${count === 1 ? 'ticket' : 'tickets'} working here`

/** The trigger's name for a sentence, when the trigger is still there to name. */
export const standingAccessTriggerName = (row: Pick<ExecutorStandingPolicyRow, 'trigger'>): string =>
  row.trigger ? `“${row.trigger.name}”` : 'a deleted trigger'

/** What the End confirmation asks and says. */
export const standingAccessEndCopy = (row: Pick<ExecutorStandingPolicyRow, 'authorName' | 'trigger'>) => ({
  body: `Ending it cancels ${row.trigger ? 'this trigger’s' : 'its'} tickets that are working or waiting, and closes `
    + `their coding sessions on its machines. ${row.authorName} has to set it up again before any of its tickets `
    + 'runs on a machine.',
  confirmLabel: 'End standing access',
  title: `End standing access for ${standingAccessTriggerName(row)}?`,
})
