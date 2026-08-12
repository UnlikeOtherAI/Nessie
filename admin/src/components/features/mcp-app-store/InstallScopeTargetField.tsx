import { useEffect } from 'react'
import type { McpServerScopeType } from '@nessie/schemas'
import { useChannels } from '../../../facades/channels/hooks'
import { useProjects, useTeams } from '../../../facades/projects/hooks'
import {
  defaultScopeTargetId,
  scopeTargetChoices,
  type ScopeTargetChoices,
} from './install-scope-targets'

/**
 * "Which one?" for the selected install scope. Reads the viewer's own
 * project/team/channel lists through the existing facades — no new endpoint, and
 * no UUID to copy from somewhere else in the product.
 *
 * The lists are already scoped by entitlement server-side, so this renders what
 * the API returns without narrowing it further.
 */

type InstallScopeTargetFieldProps = {
  scopeType: McpServerScopeType
  value: string
  onChange: (scopeId: string) => void
  organization: { id: string; label: string }
  currentUser: { id: string; label: string }
  labelClass: string
  inputClass: string
}

const fixedRowClass = [
  'admin-input mt-1 flex items-center',
  'bg-[var(--scrim)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--tx)]',
].join(' ')

const scopeTitle: Record<McpServerScopeType, string> = {
  organization: 'Organisation',
  project: 'Project',
  team: 'Team',
  channel: 'Channel',
  user: 'User',
  system: 'Scope target ID (UUID)',
}

const emptyListNote: Partial<Record<McpServerScopeType, string>> = {
  project: 'You are not a member of any project yet.',
  team: 'No teams exist in this organisation yet.',
  channel: 'No channels exist in this organisation yet.',
}

export const InstallScopeTargetField = ({
  scopeType,
  value,
  onChange,
  organization,
  currentUser,
  labelClass,
  inputClass,
}: InstallScopeTargetFieldProps) => {
  const projects = useProjects()
  const teams = useTeams()
  const channels = useChannels()

  const choices: ScopeTargetChoices = scopeTargetChoices(scopeType, {
    organization,
    currentUser,
    projects: projects.data ?? [],
    teams: teams.data ?? [],
    channels: channels.data ?? [],
  })

  // The lists load asynchronously, so the scope-type switch cannot always pick a
  // default. Whenever the selection is not one of the offered targets — right
  // after the switch, or when a list finally arrives — adopt the first one, so a
  // visible choice always matches what submit will send.
  const unselected =
    choices.kind === 'list' && choices.targets.length > 0
    && !choices.targets.some((target) => target.id === value)
      ? defaultScopeTargetId(choices)
      : null
  useEffect(() => {
    if (unselected) onChange(unselected)
  }, [unselected, onChange])

  if (choices.kind === 'fixed') {
    return (
      <div className={labelClass}>
        {scopeTitle[scopeType]}
        <div className={fixedRowClass}>{choices.target.label}</div>
      </div>
    )
  }

  if (choices.kind === 'freeform') {
    return (
      <label className={labelClass}>
        {scopeTitle[scopeType]}
        <input
          className={inputClass}
          onChange={(event) => onChange(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          value={value}
        />
      </label>
    )
  }

  const loading =
    (scopeType === 'project' && projects.isLoading)
    || (scopeType === 'team' && (teams.isLoading || projects.isLoading))
    || (scopeType === 'channel' && channels.isLoading)

  if (loading) {
    return (
      <div className={labelClass}>
        {scopeTitle[scopeType]}
        <div className={fixedRowClass}>Loading…</div>
      </div>
    )
  }

  if (choices.targets.length === 0) {
    return (
      <div className={labelClass}>
        {scopeTitle[scopeType]}
        <div className={fixedRowClass}>
          {emptyListNote[scopeType] ?? 'Nothing available at this scope.'}
        </div>
      </div>
    )
  }

  return (
    <label className={labelClass}>
      {scopeTitle[scopeType]}
      <select
        className={inputClass}
        data-testid="install-scope-target"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {choices.targets.map((target) => (
          <option key={target.id} value={target.id}>
            {target.label}
          </option>
        ))}
      </select>
    </label>
  )
}
