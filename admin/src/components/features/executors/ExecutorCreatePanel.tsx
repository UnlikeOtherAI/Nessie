import { useState } from 'react'
import {
  ExecutorPrivateAssignmentSchema,
  ExecutorScopeSchema,
  type ExecutorCreateResponse,
} from '@nessie/schemas'
import type { AgentRecord, ProjectRecord, UserRecord } from '../../../lib/api-client'
import { useCreateExecutor } from '../../../facades/executors/hooks'

type ExecutorCreatePanelProps = {
  agents: AgentRecord[]
  currentUserId: string
  fixedProjectId?: string
  onCreated: (created: ExecutorCreateResponse) => void
  organizationId: string
  projects: ProjectRecord[]
  users: UserRecord[]
}

type ScopeKind = 'private' | 'project' | 'organization'
type UserRole = 'none' | 'use' | 'admin'

export const ExecutorCreatePanel = ({
  agents,
  currentUserId,
  fixedProjectId,
  onCreated,
  organizationId,
  projects,
  users,
}: ExecutorCreatePanelProps) => {
  const createExecutor = useCreateExecutor()
  const [label, setLabel] = useState('My executor')
  const [scopeKind, setScopeKind] = useState<ScopeKind>(fixedProjectId ? 'project' : 'private')
  const [projectId, setProjectId] = useState(fixedProjectId ?? '')
  const [userRoles, setUserRoles] = useState<Record<string, UserRole>>(() => ({
    [currentUserId]: 'admin',
  }))
  const [agentIds, setAgentIds] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    try {
      const scope = ExecutorScopeSchema.parse(
        scopeKind === 'project'
          ? { kind: 'project', organizationId, projectId }
          : { kind: scopeKind, organizationId },
      )
      const privateAssignments = scopeKind === 'private'
        ? ExecutorPrivateAssignmentSchema.array().parse([
            ...users.flatMap((user) => {
              const role = userRoles[user.id] ?? 'none'
              return role === 'none'
                ? []
                : [{ principalKind: 'user' as const, userId: user.id, role }]
            }),
            ...agents.filter((agent) => agentIds.has(agent.id)).map((agent) => ({
              agentId: agent.id,
              principalKind: 'agent' as const,
              role: 'use' as const,
            })),
          ])
        : undefined
      const created = await createExecutor.mutateAsync({
        label: label.trim(),
        scope,
        ...(privateAssignments ? { privateAssignments } : {}),
      })
      onCreated(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create executor.')
    }
  }

  const setAgentSelected = (agentId: string, selected: boolean) => {
    setAgentIds((current) => {
      const next = new Set(current)
      if (selected) next.add(agentId)
      else next.delete(agentId)
      return next
    })
  }

  return (
    <form className="admin-card grid gap-4 p-4" onSubmit={submit}>
      <div>
        <h2 className="text-sm font-semibold text-[color:var(--tx)]">Pair an executor</h2>
        <p className="mt-1 text-xs text-[color:var(--tx3)]">
          Scope cannot be changed after pairing. A private executor can be shared with any exact
          combination of people and agents, but only its assigned people can administer that list.
        </p>
      </div>
      <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
        Name
        <input className="admin-input" maxLength={120} onChange={(event) => setLabel(event.target.value)} value={label} />
      </label>
      {fixedProjectId ? (
        <p className="rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] px-3 py-2 text-xs text-[color:var(--tx2)]">
          Scope: <span className="font-medium text-[color:var(--tx)]">this project only</span>
        </p>
      ) : (
        <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
          Scope
          <select className="admin-input" onChange={(event) => setScopeKind(event.target.value as ScopeKind)} value={scopeKind}>
            <option value="private">Private — exact people and agents</option>
            <option value="project">Project — exact project members</option>
            <option value="organization">Organization — organization members</option>
          </select>
        </label>
      )}
      {scopeKind === 'project' ? (
        <label className="grid gap-1 text-xs font-medium text-[color:var(--tx2)]">
          Project
          <select className="admin-input" disabled={Boolean(fixedProjectId)} onChange={(event) => setProjectId(event.target.value)} required value={projectId}>
            <option value="">Choose a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      ) : null}
      {scopeKind === 'private' ? (
        <div className="grid gap-3">
          <div>
            <p className="text-xs font-semibold text-[color:var(--tx2)]">People</p>
            <p className="text-xs text-[color:var(--tx3)]">Keep at least one human administrator.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {users.map((user) => (
              <label className="flex items-center gap-2 text-xs text-[color:var(--tx2)]" key={user.id}>
                <span className="min-w-0 flex-1 truncate">{user.displayName}{user.id === currentUserId ? ' (you)' : ''}</span>
                <select
                  className="admin-input admin-input-compact w-24"
                  onChange={(event) => setUserRoles((current) => ({
                    ...current,
                    [user.id]: event.target.value as UserRole,
                  }))}
                  value={userRoles[user.id] ?? 'none'}
                >
                  <option value="none">No access</option>
                  <option value="use">Use</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold text-[color:var(--tx2)]">Agents</p>
            <p className="text-xs text-[color:var(--tx3)]">Agents receive use access only; a person must grant each operation separately.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {agents.map((agent) => (
              <label className="flex items-center gap-2 text-xs text-[color:var(--tx2)]" key={agent.id}>
                <input
                  checked={agentIds.has(agent.id)}
                  onChange={(event) => setAgentSelected(agent.id, event.target.checked)}
                  type="checkbox"
                />
                <span>{agent.name}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p className="text-xs text-[color:var(--danger-text)]">{error}</p> : null}
      <button className="admin-button admin-button-primary justify-self-start" disabled={createExecutor.isPending} type="submit">
        {createExecutor.isPending ? 'Creating…' : 'Create pairing'}
      </button>
    </form>
  )
}
