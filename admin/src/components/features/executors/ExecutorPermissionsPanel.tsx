import { useState } from 'react'
import type { ExecutorSharingChange } from '@nessie/schemas'
import { useExecutorSharing, useUpdateExecutorSharing } from '../../../facades/executors/sharing'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'

export const ExecutorPermissionsPanel = ({ executorId, teamId }: { executorId: string; teamId?: string }) => {
  const sharing = useExecutorSharing(executorId, teamId)
  const update = useUpdateExecutorSharing()
  const [person, setPerson] = useState('')
  const [role, setRole] = useState<'use' | 'admin'>('use')
  const [project, setProject] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async (change: ExecutorSharingChange) => {
    if (!teamId) return
    setError(null)
    try {
      await update.mutateAsync({ executorId, teamId, change })
      setPerson('')
      setProject('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Access could not be updated.') }
  }
  if (!teamId) return <p>Select a team to manage sharing.</p>
  const data = sharing.data
  return <QueryState query={sharing} loadingLabel="Loading permissions…" errorLabel="Permissions could not be loaded.">
    {() => data ? <div className="grid gap-6">
      <FormError>{error}</FormError>
      <section className="grid gap-3" aria-label="Team access">
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={data.everyone} disabled={update.isPending}
            onChange={(event) => void save({ kind: 'team', enabled: event.target.checked })} />
          Everyone in this team can use this executor
        </label>
        <p className="text-xs text-[color:var(--tx3)]">
          Sharing with the team or a project also lets team administrators manage this executor.
        </p>
      </section>
      <section className="grid gap-3" aria-label="People with access">
        <h2 className="text-sm font-semibold">People</h2>
        <ul className="divide-y divide-[color:var(--sep)]">
          {data.people.map((entry) => <li key={entry.userId} className="flex flex-wrap items-center gap-3 py-3">
            <span className="min-w-0 flex-1 text-sm">{entry.name}</span>
            {entry.userId === data.ownerUserId ? <span className="text-xs text-[color:var(--tx3)]">Owner</span> : <>
            <select aria-label={`Access for ${entry.name}`} className="admin-input" value={entry.role} disabled={update.isPending}
              onChange={(event) => void save({ kind: 'person', userId: entry.userId, role: event.target.value as 'use' | 'admin' })}>
              <option value="use">Can use</option><option value="admin">Admin</option>
            </select>
            <button className="admin-button admin-button-secondary" disabled={update.isPending}
              onClick={() => void save({ kind: 'person', userId: entry.userId, role: null })} type="button">Remove</button>
            </>}
          </li>)}
        </ul>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
          event.preventDefault(); if (person) void save({ kind: 'person', userId: person, role })
        }}>
          <label className="grid min-w-0 flex-1 gap-1 text-sm">Person
            <select aria-label="Person" className="admin-input" value={person} onChange={(event) => setPerson(event.target.value)} required>
              <option value="">Choose a person</option>
              {data.availablePeople.filter((entry) => !data.people.some((p) => p.userId === entry.userId))
                .map((entry) => <option key={entry.userId} value={entry.userId}>{entry.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Access
            <select aria-label="Access" className="admin-input" value={role} onChange={(event) => setRole(event.target.value as 'use' | 'admin')}>
              <option value="use">Can use</option><option value="admin">Admin</option>
            </select>
          </label>
          <button className="admin-button admin-button-primary" disabled={!person || update.isPending} type="submit">Add person</button>
        </form>
      </section>
      <section className="grid gap-3" aria-label="Projects with access">
        <h2 className="text-sm font-semibold">Projects</h2>
        <p className="text-xs text-[color:var(--tx3)]">Project members can use the executor for that project's work.</p>
        <ul className="divide-y divide-[color:var(--sep)]">
          {data.projects.map((entry) => <li key={entry.projectId} className="flex items-center gap-3 py-3">
            <span className="min-w-0 flex-1 text-sm">{entry.name}</span>
            <span className="text-xs text-[color:var(--tx3)]">Can use</span>
            <button className="admin-button admin-button-secondary" disabled={update.isPending} type="button"
              onClick={() => void save({ kind: 'project', projectId: entry.projectId, enabled: false })}>Remove</button>
          </li>)}
        </ul>
        <form className="flex items-end gap-3" onSubmit={(event) => {
          event.preventDefault(); if (project) void save({ kind: 'project', projectId: project, enabled: true })
        }}>
          <label className="grid min-w-0 flex-1 gap-1 text-sm">Project
            <select aria-label="Project" className="admin-input" value={project} onChange={(event) => setProject(event.target.value)} required>
              <option value="">Choose a project</option>
              {data.availableProjects.filter((entry) => !data.projects.some((p) => p.projectId === entry.projectId))
                .map((entry) => <option key={entry.projectId} value={entry.projectId}>{entry.name}</option>)}
            </select>
          </label>
          <button className="admin-button admin-button-primary" disabled={!project || update.isPending} type="submit">Add project</button>
        </form>
      </section>
    </div> : null}
  </QueryState>
}
