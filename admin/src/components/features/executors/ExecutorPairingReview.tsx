import { useState } from 'react'
import type { ExecutorPairingOptions, ExecutorPairingPreview, ExecutorScope } from '@nessie/schemas'
import { ExecutorScopeSchema } from '@nessie/schemas'
import type { ProjectRecord } from '../../../lib/api-client'
import { FormActions, FormError } from '../../shared/FormActions'

type Props = {
  busy: boolean
  error: string | null
  fixedProjectId?: string
  onBack: () => void
  onClaim: (input: { label: string; scope: ExecutorScope; teamId: string | null }) => void
  options: ExecutorPairingOptions
  preview: ExecutorPairingPreview
  projects: ProjectRecord[]
  remaining: number
}

const scopeLabels = {
  private: 'Only me',
  project: 'People in a project',
  organization: 'People in the organisation',
} as const
const platformLabels = { linux: 'Linux', macos: 'Mac', windows: 'Windows' } as const

export const ExecutorPairingReview = ({
  busy, error, fixedProjectId, onBack, onClaim, options, preview, projects, remaining,
}: Props) => {
  const [label, setLabel] = useState(preview.machineName)
  const [scopeKind, setScopeKind] = useState<ExecutorScope['kind']>(fixedProjectId ? 'project' : 'private')
  const [projectId, setProjectId] = useState(fixedProjectId ?? '')
  const fixedTeam = fixedProjectId ? options.teams.find((team) => team.projectIds.includes(fixedProjectId)) : null
  const [teamId, setTeamId] = useState(fixedTeam?.id ?? (options.teams.length === 1 ? options.teams[0]!.id : ''))
  const [confirmed, setConfirmed] = useState(false)
  const team = options.teams.find((candidate) => candidate.id === teamId)
  const availableProjects = projects.filter((project) => team?.projectIds.includes(project.id))
  const selectionValid = (options.teams.length === 0 || Boolean(team))
    && options.scopes.includes(scopeKind)
    && (scopeKind !== 'project' || availableProjects.some((project) => project.id === projectId))

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!confirmed || !selectionValid || !label.trim() || busy) return
        onClaim({
          label: label.trim(),
          scope: ExecutorScopeSchema.parse(scopeKind === 'project'
            ? { kind: 'project', organizationId: options.organization.id, projectId }
            : { kind: scopeKind, organizationId: options.organization.id }),
          teamId: teamId || null,
        })
      }}
    >
      <div className="grid gap-1 text-sm text-[color:var(--tx2)]">
        <p><strong className="text-[color:var(--tx)]">{preview.machineName}</strong> · {platformLabels[preview.platformFacts.platform.os]}</p>
        <p>Organisation: <strong className="text-[color:var(--tx)]">{options.organization.name}</strong></p>
        <p className="text-xs text-[color:var(--tx3)]">Code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p>
      </div>
      {options.teams.length > 0 ? (
        <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
          Team
          <select
            aria-label="Team"
            className="admin-input"
            disabled={Boolean(fixedProjectId)}
            onChange={(event) => { setTeamId(event.target.value); setProjectId('') }}
            required
            value={teamId}
          >
            <option value="">Choose a team</option>
            {options.teams.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
      ) : <p className="text-xs text-[color:var(--tx3)]">No team is connected to this organisation.</p>}
      <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
        Machine name
        <input className="admin-input" maxLength={120} onChange={(event) => setLabel(event.target.value)} required value={label} />
      </label>
      <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
        Who can use this machine?
        <select
          className="admin-input"
          disabled={Boolean(fixedProjectId)}
          onChange={(event) => setScopeKind(event.target.value as ExecutorScope['kind'])}
          value={scopeKind}
        >
          {options.scopes.map((kind) => <option key={kind} value={kind}>{scopeLabels[kind]}</option>)}
        </select>
      </label>
      {scopeKind === 'project' ? (
        <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
          Project
          <select
            aria-label="Project"
            className="admin-input"
            disabled={Boolean(fixedProjectId)}
            onChange={(event) => setProjectId(event.target.value)}
            required
            value={projectId}
          >
            <option value="">Choose a project</option>
            {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      ) : null}
      <p className="text-xs text-[color:var(--tx3)]">
        {scopeKind === 'private' ? 'You can share access with selected people and agents after pairing. ' : ''}
        Agents still need permission for each kind of work.
      </p>
      <label className="grid gap-2 border-t border-[color:var(--sep)] pt-3 text-xs text-[color:var(--tx2)]">
        <span className="break-all font-mono text-[color:var(--tx3)]">{preview.fingerprint}</span>
        <span className="flex items-start gap-2">
          <input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
          <span>The fingerprint matches the one shown on my machine.</span>
        </span>
      </label>
      {fixedProjectId && !fixedTeam ? (
        <FormError>This project's team is unavailable. Choose a project you can access.</FormError>
      ) : null}
      <FormError>{error}</FormError>
      <FormActions>
        <button className="admin-button admin-button-secondary" disabled={busy} onClick={onBack} type="button">Back</button>
        <button
          className="admin-button admin-button-primary"
          disabled={busy || !confirmed || !selectionValid || !label.trim()}
          type="submit"
        >
          {busy ? 'Pairing…' : 'Pair machine'}
        </button>
      </FormActions>
    </form>
  )
}
