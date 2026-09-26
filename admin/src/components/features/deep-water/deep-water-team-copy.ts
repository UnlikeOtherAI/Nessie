import { ApiClientError } from '@nessie/client-core'
import {
  DeepWaterActiveRunConflictSchema,
  type DeepWaterActiveRunConflict,
  type DeepWaterResearchReadinessState,
} from '@nessie/schemas'
import { readinessCopy } from './research-presentation'

/**
 * What the `/admin/apps/deep-water` hero says about DeepWater for this team, and
 * what an owner's turn-on, turn-off or update refusal means (nessie.md §7.7
 * doorways, amendments N8.5 and N9). Pure, so every wording is tested without a
 * DOM. Plain UK English; no infrastructure names.
 */

export type TeamControl = 'turn_on' | 'turn_off' | 'update'

/**
 * The changes a team owner can make from here, given the verdict and the team
 * switch, the one to reach for first: a team that is off can be turned on; one
 * that is on can be turned off; one that needs updating (which is on — only an
 * enabled team's tools can be out of date) can be updated, or turned off
 * without updating it first. `viewerIsOwner` is the session's owner role —
 * the team-enablement route refuses anyone else, admins included — so nobody
 * else is offered a control the server would refuse. Cancelling a research is
 * the wider owner-or-admin standing (amendments N8.5): the verdict's
 * `viewerCanChangeTeam` here, and each run's own `viewer.canCancel` elsewhere.
 */
export const deepWaterTeamControls = (
  state: DeepWaterResearchReadinessState,
  teamEnabled: boolean,
  viewerIsOwner: boolean,
): TeamControl[] => {
  if (!viewerIsOwner) return []
  if (!teamEnabled) return ['turn_on']
  return state === 'contract_outdated' ? ['update', 'turn_off'] : ['turn_off']
}

export const TEAM_CONTROL_LABEL: Record<TeamControl, string> = {
  turn_off: 'Turn off DeepWater',
  turn_on: 'Turn on DeepWater',
  update: 'Update DeepWater',
}

/** The hero's one sentence about where DeepWater stands for this team. */
export const deepWaterTeamStatus = (
  state: DeepWaterResearchReadinessState,
  teamEnabled: boolean,
  viewerIsOwner: boolean,
): string => {
  if (state === 'ready') {
    return 'DeepWater is on for this team. Anyone who can post in a conversation can start research from its '
      + 'Research button, and agents you give it to can research for you.'
  }
  if (state === 'account_not_linked' && teamEnabled) {
    return `DeepWater is on for this team. ${readinessCopy(state, viewerIsOwner).message}`
  }
  return readinessCopy(state, viewerIsOwner).message
}

export type TeamChangeFailure =
  /** A research is still open and would lose its tools; an owner can cancel it here. */
  | { kind: 'open_research'; run: DeepWaterActiveRunConflict }
  | { kind: 'message'; message: string }

const OPEN_RESEARCH_WITHOUT_RUN = 'A research is still open for this team. It has to finish, or be cancelled from '
  + 'its conversation, before DeepWater can be changed.'

/**
 * Why turning DeepWater on, off or updating it was refused. An open research
 * names its run (id, status, origin and requester — never its topic), so the
 * owner can cancel it without reading it.
 */
export const teamChangeFailure = (error: unknown): TeamChangeFailure => {
  if (!(error instanceof ApiClientError)) {
    return { kind: 'message', message: 'Nessie didn’t answer. Check your connection, then try again.' }
  }
  if (error.code === 'LEDGER_DEEPWATER_ACTIVE_RUNS') {
    const run = DeepWaterActiveRunConflictSchema.safeParse(error.details)
    if (run.success) return { kind: 'open_research', run: run.data }
    console.error('[deep-water] an open-research refusal did not name its run', error.details)
    return { kind: 'message', message: OPEN_RESEARCH_WITHOUT_RUN }
  }
  if (error.status === 503) {
    return {
      kind: 'message',
      message: 'DeepWater isn’t set up on this Nessie server yet, so it can’t be turned on. '
        + 'Whoever runs your Nessie server can finish setting it up.',
    }
  }
  if (error.status === 403) {
    return { kind: 'message', message: 'Only a team owner can change DeepWater for this team.' }
  }
  return { kind: 'message', message: 'DeepWater couldn’t be changed just now. Try again.' }
}

const OPEN_STATUS_WORDS: Record<string, string> = {
  drafting: 'having its brief agreed',
  needs_setup: 'waiting to be recovered',
  queued: 'waiting to start',
  running: 'being researched',
}

/**
 * Where the owner stands with the research that refused the change:
 * - `can_cancel` — the owner-or-admin cancel standing (`viewerCanChangeTeam`),
 *   so Cancel is offered beside the sentence;
 * - `cannot_cancel` — without it, the sentence does not point at a Cancel that
 *   is not there;
 * - `cancel_requested` — the cancel was accepted, but DeepWater has not
 *   stopped the research yet, so the change would still be refused;
 * - `cancel_failed` — the research's own view says its last cancel did not go
 *   through (`cancelFailure`): DeepWater refused it or could not be asked, so
 *   Cancel is offered again with the reason;
 * - `cancel_unconfirmed` — for an owner who may not read the research, the
 *   change was refused by it again after their cancel was accepted: they
 *   cannot see whether that cancel went through, so Cancel is offered again
 *   (a newer cancel replaces the one before, never doubles it);
 * - `stopped` — it has stopped, and the change can be tried again.
 */
export type OpenResearchStanding =
  | 'can_cancel'
  | 'cannot_cancel'
  | 'cancel_requested'
  | 'cancel_failed'
  | 'cancel_unconfirmed'
  | 'stopped'

export type OpenResearchFacts = {
  /** The verdict's cancel standing: owners and admins. */
  canCancel: boolean
  /** This owner's cancel of the research was accepted on this screen. */
  cancelRequested: boolean
  /** Trying the change again was refused by the same research since that cancel was accepted. */
  refusedAgain: boolean
  /** The cancel's own answer said the research had already stopped. */
  stoppedOnAnswer: boolean
  /** The research as this owner reads it; null while it loads, and for an owner who may not read it. */
  view: { finished: boolean; cancelFailed: boolean } | null
  /** The owner may not read the research: its read answered 404. */
  unreadable: boolean
}

/**
 * The standing, from what this screen knows. The research's own view is
 * exact, so it decides for an owner who may read it; an owner who may not
 * learns only that the change is still refused.
 */
export const openResearchStanding = (facts: OpenResearchFacts): OpenResearchStanding => {
  if (facts.stoppedOnAnswer || facts.view?.finished) return 'stopped'
  if (facts.view?.cancelFailed) return facts.canCancel ? 'cancel_failed' : 'cannot_cancel'
  if (facts.cancelRequested) {
    return facts.unreadable && facts.refusedAgain && facts.canCancel ? 'cancel_unconfirmed' : 'cancel_requested'
  }
  return facts.canCancel ? 'can_cancel' : 'cannot_cancel'
}

/** Cancel again, after one that did not go through or whose outcome cannot be seen. */
export const cancelOfferedAgain = (standing: OpenResearchStanding): boolean =>
  standing === 'cancel_failed' || standing === 'cancel_unconfirmed'

/** "A research started by Jana is still being researched." */
export const openResearchSentence = (
  run: DeepWaterActiveRunConflict,
  requesterName: string | null,
  standing: OpenResearchStanding,
): string => {
  const who = run.originKind === 'agent'
    ? 'an agent'
    : requesterName ?? 'someone in this team'
  const where = OPEN_STATUS_WORDS[run.status] ?? 'still open'
  switch (standing) {
    case 'can_cancel':
      return `A research started by ${who} is ${where}. It keeps DeepWater as it is until it ends — cancel it `
        + 'here, or let it finish, then try again.'
    case 'cannot_cancel':
      return `A research started by ${who} is ${where}. It keeps DeepWater as it is until it ends — try again `
        + 'once it has finished.'
    case 'cancel_requested':
      return `Cancel requested for the research started by ${who}. Until it has stopped, DeepWater stays as it `
        + 'is — try again once it has.'
    case 'cancel_failed':
      return `The research started by ${who} wasn’t cancelled: it is ${where}, and DeepWater stays as it is `
        + 'until it ends — cancel it again, or let it finish, then try again.'
    case 'cancel_unconfirmed':
      return `Cancel requested for the research started by ${who}, but it is still open — the cancel may not `
        + 'have gone through. Cancel it again, or try again once it has stopped.'
    case 'stopped':
      return `The research started by ${who} has stopped. You can try again now.`
  }
}
