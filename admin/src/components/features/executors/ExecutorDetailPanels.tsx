import { useState } from 'react'
import type {
  ExecutorAccessViewResponse,
  ExecutorRecordResponse,
  PreparedExecutorAccessChangeResponse,
} from '@nessie/schemas'
import type { AgentRecord, UserRecord } from '../../../lib/api-client'
import { usePrepareExecutorAccessChange } from '../../../facades/executors/hooks'

type ExecutorTab = 'overview' | 'access' | 'operations' | 'sessions' | 'attention'

type ExecutorDetailPanelsProps = {
  access: ExecutorAccessViewResponse | undefined
  agents: AgentRecord[]
  executor: ExecutorRecordResponse
  onPrepared: (prepared: PreparedExecutorAccessChangeResponse) => void
  users: UserRecord[]
}

const operationKeys = [
  'file.list', 'file.read', 'file.write', 'command.run', 'browser.open',
  'browser.observe', 'browser.act', 'workspace.promote', 'sandbox.stop',
  'coding.launch', 'coding.attach', 'coding.observe', 'coding.prompt',
  'coding.interrupt', 'coding.close',
] as const

const tabClass = (selected: boolean): string => [
  'rounded-md px-2.5 py-1.5 text-xs font-semibold',
  selected
    ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
    : 'text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]',
].join(' ')

const scopeSummary = (executor: ExecutorRecordResponse): string =>
  executor.scope.kind === 'private'
    ? 'Private — only exact assigned people and agents can use it.'
    : executor.scope.kind === 'project'
      ? `Project — eligible only for runs in project ${executor.scope.projectId}.`
      : 'Organization — available only to entitled organization work.'

export const ExecutorDetailPanels = ({
  access,
  agents,
  executor,
  onPrepared,
  users,
}: ExecutorDetailPanelsProps) => {
  const [tab, setTab] = useState<ExecutorTab>('overview')
  const [principalKind, setPrincipalKind] = useState<'user' | 'agent'>('user')
  const [principalId, setPrincipalId] = useState('')
  const [assignmentAction, setAssignmentAction] = useState<'set' | 'remove'>('set')
  const [assignmentRole, setAssignmentRole] = useState<'use' | 'admin'>('use')
  const [grantAgentId, setGrantAgentId] = useState('')
  const [grantOperation, setGrantOperation] = useState<(typeof operationKeys)[number]>('file.read')
  const [grantState, setGrantState] = useState<'allowed' | 'denied'>('allowed')
  const [error, setError] = useState<string | null>(null)
  const prepare = usePrepareExecutorAccessChange()

  const submitPrepared = async (change: unknown) => {
    setError(null)
    try {
      onPrepared(await prepare.mutateAsync({ executorId: executor.id, change }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to prepare this change.')
    }
  }

  const selectValues = principalKind === 'user' ? users : agents
  const canManage = access?.canManage === true

  return (
    <section className="admin-card min-h-0 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--sep)] pb-3">
        <div>
          <h2 className="text-base font-semibold text-[color:var(--tx)]">{executor.label}</h2>
          <p className="mt-0.5 text-xs text-[color:var(--tx3)]">{scopeSummary(executor)}</p>
        </div>
        <span className="rounded-full border border-[color:var(--sep)] px-2 py-1 text-xs text-[color:var(--tx2)]">
          {executor.status}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1" role="tablist">
        {(['overview', 'access', 'operations', 'sessions', 'attention'] as const).map((item) => (
          <button className={tabClass(tab === item)} key={item} onClick={() => setTab(item)} type="button">
            {item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      {error ? <p className="mt-3 text-xs text-[color:var(--danger-text)]">{error}</p> : null}
      {tab === 'overview' ? (
        <div className="mt-4 grid gap-3 text-sm text-[color:var(--tx2)]">
          <p><span className="font-medium text-[color:var(--tx)]">Profiles:</span> {executor.profiles.join(', ') || 'None approved yet'}</p>
          <p><span className="font-medium text-[color:var(--tx)]">Data boundary:</span> paired executors run only the reviewed local policy. They do not expose host credentials, a host shell, or raw session output to Nessie.</p>
          <p><span className="font-medium text-[color:var(--tx)]">Last seen:</span> {executor.lastSeenAt ?? 'Never'}</p>
          {executor.statusDetail ? <p className="text-xs text-[color:var(--tx3)]">{executor.statusDetail}</p> : null}
        </div>
      ) : null}
      {tab === 'access' ? (
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-[color:var(--tx2)]">
            Your effective access: private={access?.effectiveAccess.privateAssignment ?? 'unknown'}, project={access?.effectiveAccess.projectRole ?? 'none'}, organization={access?.effectiveAccess.organizationRole ?? 'none'}.
          </p>
          {executor.scope.kind === 'private' && canManage ? (
            <div className="grid gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]">Private assignments</p>
              {(access?.privateAssignments ?? []).map((assignment) => {
                const name = assignment.principalKind === 'user'
                  ? users.find((user) => user.id === assignment.userId)?.displayName ?? assignment.userId
                  : agents.find((agent) => agent.id === assignment.agentId)?.name ?? assignment.agentId
                return <p className="text-xs text-[color:var(--tx2)]" key={`${assignment.principalKind}-${name}`}>{name} · {assignment.principalKind} · {assignment.role}</p>
              })}
            </div>
          ) : null}
          {canManage && executor.scope.kind === 'private' ? (
            <form className="grid gap-2 border-t border-[color:var(--sep)] pt-3" onSubmit={(event) => {
              event.preventDefault()
              if (!principalId) return setError('Choose a person or agent.')
              const principal = principalKind === 'user'
                ? { principalKind, userId: principalId }
                : { principalKind, agentId: principalId }
              void submitPrepared(assignmentAction === 'set'
                ? {
                    kind: 'private_assignment',
                    action: 'set',
                    assignment: principalKind === 'user'
                      ? { ...principal, role: assignmentRole }
                      : { ...principal, role: 'use' },
                  }
                : { kind: 'private_assignment', action: 'remove', principal })
            }}>
              <p className="text-xs font-semibold text-[color:var(--tx)]">Prepare assignment change</p>
              <div className="grid gap-2 sm:grid-cols-4">
                <select className="admin-input" onChange={(event) => setAssignmentAction(event.target.value as 'set' | 'remove')} value={assignmentAction}>
                  <option value="set">Set access</option><option value="remove">Remove access</option>
                </select>
                <select className="admin-input" onChange={(event) => { setPrincipalKind(event.target.value as 'user' | 'agent'); setPrincipalId('') }} value={principalKind}>
                  <option value="user">Person</option><option value="agent">Agent</option>
                </select>
                <select className="admin-input" onChange={(event) => setPrincipalId(event.target.value)} value={principalId}>
                  <option value="">Choose {principalKind}</option>
                  {selectValues.map((value) => <option key={value.id} value={value.id}>{'displayName' in value ? value.displayName : value.name}</option>)}
                </select>
                {principalKind === 'user' && assignmentAction === 'set' ? (
                  <select className="admin-input" onChange={(event) => setAssignmentRole(event.target.value as 'use' | 'admin')} value={assignmentRole}>
                    <option value="use">Use</option><option value="admin">Admin</option>
                  </select>
                ) : <span />}
              </div>
              <button className="admin-button admin-button-secondary justify-self-start" disabled={prepare.isPending} type="submit">Review assignment change</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {tab === 'operations' ? (
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-[color:var(--tx2)]">An agent needs both this executor’s exact operation grant and the matching logical executor tool policy. Confirming a change updates both; an agent cannot grant either to itself or another agent.</p>
          {(access?.operationGrants ?? []).length > 0 ? (
            <div className="grid gap-1 text-xs text-[color:var(--tx2)]">
              {(access?.operationGrants ?? []).map((grant) => {
                const agentName = agents.find((agent) => agent.id === grant.agentId)?.name ?? grant.agentId
                return <p key={`${grant.agentId}-${grant.operationKey}`}>{agentName} · {grant.operationKey} · {grant.state}</p>
              })}
            </div>
          ) : <p className="text-sm text-[color:var(--tx3)]">No exact executor-operation grants are configured.</p>}
          {canManage ? (
            <form className="grid gap-2 border-t border-[color:var(--sep)] pt-3" onSubmit={(event) => {
              event.preventDefault()
              if (!grantAgentId) return setError('Choose an agent.')
              void submitPrepared({
                kind: 'agent_operation_grant',
                agentId: grantAgentId,
                operationKey: grantOperation,
                state: grantState,
              })
            }}>
              <p className="text-xs font-semibold text-[color:var(--tx)]">Prepare paired agent-operation grant</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <select className="admin-input" onChange={(event) => setGrantAgentId(event.target.value)} value={grantAgentId}>
                  <option value="">Choose agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
                <select className="admin-input" onChange={(event) => setGrantOperation(event.target.value as typeof grantOperation)} value={grantOperation}>
                  {operationKeys.map((operation) => <option key={operation} value={operation}>{operation}</option>)}
                </select>
                <select className="admin-input" onChange={(event) => setGrantState(event.target.value as 'allowed' | 'denied')} value={grantState}>
                  <option value="allowed">Allow</option><option value="denied">Deny</option>
                </select>
              </div>
              <button className="admin-button admin-button-secondary justify-self-start" disabled={prepare.isPending} type="submit">Review operation change</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {tab === 'sessions' ? <p className="mt-4 text-sm text-[color:var(--tx3)]">No executor session is attached. Session launch and control remain unavailable until an approved operation is bound to a run.</p> : null}
      {tab === 'attention' ? (
        <div className="mt-4 grid gap-3">
          <p className="text-sm text-[color:var(--tx2)]">Status: {executor.status}. {executor.statusDetail ?? 'No active attention item.'}</p>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {(['pause', 'drain', 'revoke'] as const).map((action) => (
                <button
                  className={action === 'revoke' ? 'admin-button admin-button-secondary text-[color:var(--danger-text)]' : 'admin-button admin-button-secondary'}
                  disabled={prepare.isPending}
                  key={action}
                  onClick={() => void submitPrepared({ kind: 'lifecycle', action })}
                  type="button"
                >
                  Review {action}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
