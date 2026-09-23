import { ApiClientError } from '@nessie/client-core'
import {
  DeepWaterActiveRunConflictSchema,
  type DeepWaterActiveRunConflict,
  type DeepWaterResearchReadinessState,
} from '@nessie/schemas'
import { readinessCopy } from './research-presentation'

/**
 * What the `/apps/deep-water` hero says about DeepWater for this team, and
 * what an owner's turn-on, turn-off or update refusal means (nessie.md §7.7
 * doorways, amendments N8.5 and N9). Pure, so every wording is tested without a
 * DOM. Plain UK English; no infrastructure names.
 */

export type TeamControl = 'turn_on' | 'turn_off' | 'update' | null

/**
 * The one change a team owner can make from here, given the verdict and the
 * team switch. `viewerCanChangeTeam` is owner standing — the team-enablement
 * route refuses anyone else, admins included — so nobody else is offered a
 * control the server would refuse. Cancelling a research is a wider standing
 * (owners and admins, amendments N8.5) that each run's `viewer.canCancel`
 * carries on its own.
 */
export const deepWaterTeamControl = (
  state: DeepWaterResearchReadinessState,
  teamEnabled: boolean,
  viewerCanChangeTeam: boolean,
): TeamControl => {
  if (!viewerCanChangeTeam) return null
  if (state === 'contract_outdated') return 'update'
  return teamEnabled ? 'turn_off' : 'turn_on'
}

export const TEAM_CONTROL_LABEL: Record<Exclude<TeamControl, null>, string> = {
  turn_off: 'Turn off DeepWater',
  turn_on: 'Turn on DeepWater',
  update: 'Update DeepWater',
}

/** The hero's one sentence about where DeepWater stands for this team. */
export const deepWaterTeamStatus = (
  state: DeepWaterResearchReadinessState,
  teamEnabled: boolean,
  viewerCanChangeTeam: boolean,
): string => {
  if (state === 'ready') {
    return 'DeepWater is on for this team. Anyone who can post in a conversation can start research from its '
      + 'Research button, and agents you give it to can research for you.'
  }
  if (state === 'account_not_linked' && teamEnabled) {
    return `DeepWater is on for this team. ${readinessCopy(state, viewerCanChangeTeam).message}`
  }
  return readinessCopy(state, viewerCanChangeTeam).message
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
    return { kind: 'message', message: 'That didn’t reach Nessie. Check your connection, then try again.' }
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

/** "A research started by Jana is still being researched." */
export const openResearchSentence = (run: DeepWaterActiveRunConflict, requesterName: string | null): string => {
  const who = run.originKind === 'agent'
    ? 'an agent'
    : requesterName ?? 'someone in this team'
  const where = OPEN_STATUS_WORDS[run.status] ?? 'still open'
  return `A research started by ${who} is ${where}. It keeps DeepWater as it is until it ends — cancel it `
    + 'here, or let it finish, then try again.'
}
