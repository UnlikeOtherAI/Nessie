import {
  STANDING_POLICY_ANY_COMMAND_OPTION,
  type ExecutorStandingPolicyEndedReason,
  type ExecutorStandingPolicySuspendedReason,
  type StandingPolicyMachineOption,
  type TriggerMachineAccessTicket,
  type TriggerMachineAccessView,
} from '@nessie/schemas'

/**
 * How a ticket trigger's Machine access section reads
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * its state in one sentence, each ticket's place, and — for the author's
 * setup form — why a machine cannot take the work with the options chosen.
 * The server decides all of it again; these are its words for the screen.
 */

const day = (value: string): string => {
  const date = new Date(value)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

const dollars = (amount: number): string => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

export const MACHINE_ACCESS_STATE_LABEL: Record<TriggerMachineAccessView['state'], string> = {
  not_set_up: 'Not set up',
  awaiting_confirmation: 'Awaiting confirmation',
  live: 'Live',
  suspended: 'Suspended',
  ended: 'Ended',
}

export const MACHINE_ACCESS_STATE_TONE: Record<TriggerMachineAccessView['state'], 'muted' | 'accent' | 'success' | 'warning'> = {
  not_set_up: 'muted',
  awaiting_confirmation: 'accent',
  live: 'success',
  suspended: 'warning',
  ended: 'muted',
}

const SUSPENDED_BECAUSE: Record<ExecutorStandingPolicySuspendedReason, (owner: string) => string> = {
  trigger_changed: (owner) => `the trigger was edited since ${owner} confirmed it`,
  descriptor_changed: () => 'a machine’s reviewed coding setup changed',
  agent_changed: (owner) => `the agent’s instructions, model, tools or connectors were edited since ${owner} confirmed it`,
}

const ENDED_BECAUSE: Record<ExecutorStandingPolicyEndedReason, string> = {
  person: 'it was ended by hand',
  access_revoked: 'a machine’s access for the agent was withdrawn',
  executor_paused: 'a machine was paused',
  executor_drained: 'a machine was drained',
  executor_revoked: 'a machine was removed',
  descriptor_narrowed: 'a machine no longer offers reviewed coding sessions',
  author_lost_access: 'its owner can no longer edit the board',
  author_deactivated: 'its owner was deactivated',
  author_left_organization: 'its owner is no longer in the organisation',
  agent_unbound: 'the agent left the trigger’s channel',
  target_channel_unavailable: 'the trigger’s channel is no longer a public project channel',
  scope_archived: 'the project, board or a start-work column was deleted',
  trigger_disabled: 'the trigger was switched off',
  trigger_deleted: 'the trigger was deleted',
  expired: 'its card was never confirmed',
  replaced: 'a newer confirmation replaced it',
}

/** The section's one sentence under its state. */
export const machineAccessStateLine = (view: TriggerMachineAccessView): string => {
  const owner = view.author?.name ?? 'the person who set it up'
  const policy = view.policy
  switch (view.state) {
    case 'not_set_up':
      return 'Tickets this trigger picks up wait for machine access. The agent can still read and comment on them, '
        + 'but no coding agent works them.'
    case 'awaiting_confirmation':
      return `${owner} has a card to confirm with their password. Nothing runs on a machine until they do.`
    case 'live': {
      const since = policy?.confirmedAt ? ` since ${day(policy.confirmedAt)}` : ''
      const machines = policy?.machines
        ? `on ${listed(policy.machines.map((machine) => machine.label))}`
        : `on ${policy?.machineCount === 2 ? 'two machines' : 'one machine'} of ${owner}’s`
      return `Live${since}: anyone who can edit the board starts work ${machines}, as ${owner}.`
    }
    case 'suspended': {
      const because = policy?.suspendedReason ? SUSPENDED_BECAUSE[policy.suspendedReason](owner) : 'something it pinned changed'
      return `Paused because ${because}. Tickets wait until ${owner} confirms it again.`
    }
    case 'ended': {
      const because = policy?.endedReason ? ENDED_BECAUSE[policy.endedReason] : 'it ended'
      const by = policy?.endedByName ? ` by ${policy.endedByName}` : ''
      const at = policy?.endedAt ? ` ${day(policy.endedAt)}` : ''
      return `Ended${at}${by}: ${because}. Tickets wait for machine access until ${owner} sets it up again.`
    }
  }
}

/** "4 hours and $20 a ticket, $60 a day" */
export const machineAccessLimitsLine = (limits: NonNullable<TriggerMachineAccessView['policy']>['limits']): string | null =>
  limits
    ? `${limits.ticketHours} ${limits.ticketHours === 1 ? 'hour' : 'hours'} and ${dollars(limits.ticketUsd)} a ticket, `
      + `${dollars(limits.dailyUsd)} a day`
    : null

/** One ticket's place: working (on which machine, for those who may know), queued, waiting or parked. */
export const machineAccessTicketLine = (ticket: TriggerMachineAccessTicket): string => {
  switch (ticket.status) {
    case 'active':
      return ticket.machineLabel ? `working on ${ticket.machineLabel}` : 'working'
    case 'queued':
      return `queued${ticket.position ? `: position ${ticket.position}` : ''}`
        + (ticket.stateReason === 'queued_machines_offline'
          ? ', the machines are offline'
          : ticket.stateReason === 'queued_daily_limit'
            ? ', today’s spending limit is used up'
            : ', every machine is busy')
    case 'waiting_machine':
      return ticket.stateReason === 'machine_offline'
        ? `paused: ${ticket.machineLabel ?? 'its machine'} is offline`
        : ticket.stateReason === 'machine_access_suspended'
          ? 'waiting: machine access is paused'
          : 'waiting for machine access'
    case 'parked':
      return 'parked while the ticket is in review'
    default:
      return 'ended'
  }
}

export type MachineAccessChoices = {
  allowAnyCommand: boolean
  roots: readonly string[]
  ticketUsd: number
}

/**
 * Why a machine cannot take the work with these choices, in the words prepare
 * would refuse it with; null when it can.
 */
export const machineOptionRefusal = (
  option: StandingPolicyMachineOption,
  choices: MachineAccessChoices,
): string | null => {
  if (option.refusal) return option.refusal.sentence
  const facts = option.facts
  if (!facts) return `${option.label} has no reviewed coding-sessions bridge.`
  if ((facts.permissionMode === 'bypassPermissions' || facts.unaskedCommands === 'any') && !choices.allowAnyCommand) {
    return `Claude Code on ${option.label} runs any command without asking, which needs “${STANDING_POLICY_ANY_COMMAND_OPTION}” ticked.`
  }
  if (facts.turnBudgetUsd !== null && facts.turnBudgetUsd > choices.ticketUsd) {
    return `Claude Code on ${option.label} may spend ${dollars(facts.turnBudgetUsd)} a turn, more than the `
      + `${dollars(choices.ticketUsd)} a ticket may spend. Raise the ticket limit or lower its budget.`
  }
  const missing = choices.roots.filter((root) => !facts.rootNames.includes(root))
  if (missing.length > 0) return `${option.label} has no coding folder named ${listed(missing)}.`
  return null
}

/** The coding folders every chosen machine has: the ones ticket work may use. */
export const sharedCodingRoots = (options: readonly StandingPolicyMachineOption[]): string[] => {
  const [first, ...rest] = options.map((option) => option.facts?.rootNames ?? [])
  return (first ?? []).filter((root) => rest.every((roots) => roots.includes(root)))
}

/** "Claude Code, at most $5 a turn, folders nessie and site; cannot merge" */
export const machineOptionFacts = (option: StandingPolicyMachineOption): string | null => {
  const facts = option.facts
  if (!facts) return null
  const budget = facts.turnBudgetUsd === null ? 'no per-turn budget' : `at most ${dollars(facts.turnBudgetUsd)} a turn`
  const merge = facts.mergeCommands.length === 4 ? 'can merge' : 'cannot merge, so tickets stop at an open pull request'
  return `Claude Code, ${budget}, ${facts.rootNames.length === 1 ? 'folder' : 'folders'} ${listed(facts.rootNames)}; ${merge}`
}
