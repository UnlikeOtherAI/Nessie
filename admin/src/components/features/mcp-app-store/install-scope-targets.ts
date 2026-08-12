import type { McpServerScopeType } from '@nessie/schemas'
import type {
  ChannelRecord,
  ProjectRecord,
  TeamRecord,
} from '../../../lib/api-client'

/**
 * Turns the lists a viewer is already entitled to see (their projects, teams and
 * channels) into the choices the install dialog offers for a scope.
 *
 * The install tuple is `(catalogEntryId, scopeType, scopeId)`, and `scopeId` used
 * to be typed by hand. That worked only for `organization`, which is prefilled —
 * every other scope left the user hunting for a UUID with nowhere in the product
 * to copy one from. Naming the target is a choice between things the person
 * knows ("#support in Ops / Platform"), so it is a list, not a text box.
 *
 * The lists come from the API's own entitlement-scoped endpoints; this module
 * never narrows them further.
 */

export type ScopeTarget = { id: string; label: string }

export type ScopeTargetChoices =
  /** Exactly one possible target — no decision to make, so state it as a fact. */
  | { kind: 'fixed'; target: ScopeTarget }
  /** Pick one of the caller's own projects / teams / channels. */
  | { kind: 'list'; targets: ScopeTarget[] }
  /**
   * No list exists for this scope. `system` installs are provisioned by
   * first-party bootstraps, never through this dialog, so it keeps the raw id
   * rather than growing a picker for a path a person cannot reach here.
   */
  | { kind: 'freeform' }

export type ScopeTargetSources = {
  organization: ScopeTarget
  currentUser: ScopeTarget
  projects: ProjectRecord[]
  teams: TeamRecord[]
  channels: ChannelRecord[]
}

const byLabel = (left: ScopeTarget, right: ScopeTarget): number =>
  left.label.localeCompare(right.label)

const teamLabel = (team: TeamRecord, projects: ProjectRecord[]): string => {
  const project = projects.find((candidate) => candidate.id === team.projectId)
  return project ? `${project.name} / ${team.name}` : team.name
}

const channelLabel = (channel: ChannelRecord): string =>
  channel.type === 'dm'
    ? `DM · ${channel.label}`
    : `#${channel.label} · ${channel.projectName} / ${channel.teamName}`

export const scopeTargetChoices = (
  scopeType: McpServerScopeType,
  sources: ScopeTargetSources,
): ScopeTargetChoices => {
  switch (scopeType) {
    case 'organization':
      return { kind: 'fixed', target: sources.organization }
    case 'user':
      return { kind: 'fixed', target: sources.currentUser }
    case 'project':
      return {
        kind: 'list',
        targets: sources.projects
          .map((project) => ({ id: project.id, label: project.name }))
          .sort(byLabel),
      }
    case 'team':
      return {
        kind: 'list',
        targets: sources.teams
          .map((team) => ({ id: team.id, label: teamLabel(team, sources.projects) }))
          .sort(byLabel),
      }
    case 'channel':
      return {
        kind: 'list',
        targets: sources.channels
          .map((channel) => ({ id: channel.id, label: channelLabel(channel) }))
          .sort(byLabel),
      }
    case 'system':
      return { kind: 'freeform' }
  }
}

/**
 * The id to select when the scope type changes: the only target when there is
 * one, otherwise the first of the list. An empty list yields `''`, which the
 * dialog's existing "Scope ID is required" guard reports.
 */
export const defaultScopeTargetId = (choices: ScopeTargetChoices): string => {
  if (choices.kind === 'fixed') return choices.target.id
  if (choices.kind === 'list') return choices.targets[0]?.id ?? ''
  return ''
}
