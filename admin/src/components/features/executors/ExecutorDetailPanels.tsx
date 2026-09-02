import { useState } from 'react'
import { Link } from 'react-router-dom'
import type {
  ExecutorAccessViewResponse,
  ExecutorProfile,
  ExecutorRecordResponse,
  ExecutorWorkspaceReviewRecordResponse,
  ImplementedExecutorOperationKey,
  PreparedExecutorAccessChangeResponse,
} from '@nessie/schemas'
import { IMPLEMENTED_EXECUTOR_OPERATION_KEYS } from '@nessie/schemas'
import type { AgentRecord, UserRecord } from '../../../lib/api-client'
import { usePrepareExecutorAccessChange } from '../../../facades/executors/hooks'
import { useTabParam } from '../../../navigation/useTabParam'
import { FormError } from '../../shared/FormActions'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { TabBar } from '../../primitives/TabBar'

const EXECUTOR_TAB_VALUES = ['overview', 'access', 'operations', 'sessions', 'attention'] as const

type ExecutorTab = (typeof EXECUTOR_TAB_VALUES)[number]

type ExecutorDetailPanelsProps = {
  access: ExecutorAccessViewResponse | undefined
  agents: AgentRecord[]
  executor: ExecutorRecordResponse
  onPrepared: (prepared: PreparedExecutorAccessChangeResponse) => void
  reviews: ExecutorWorkspaceReviewRecordResponse[]
  users: UserRecord[]
}

const operationKeys = IMPLEMENTED_EXECUTOR_OPERATION_KEYS

const EXECUTOR_TABS: ReadonlyArray<{ label: string; value: ExecutorTab }> = [
  { label: 'Overview', value: 'overview' },
  { label: 'Access', value: 'access' },
  { label: 'Operations', value: 'operations' },
  { label: 'Sessions', value: 'sessions' },
  { label: 'Attention', value: 'attention' },
]

const scopeSummary = (executor: ExecutorRecordResponse): string =>
  executor.scope.kind === 'private'
    ? 'Private — only exact assigned people and agents can use it.'
    : executor.scope.kind === 'project'
      ? `Project — eligible only for runs in project ${executor.scope.projectId}.`
      : 'Organization — available only to entitled organization work.'

const sessionSummary = (
  profile: ExecutorProfile,
  status: 'pending' | 'active' | 'attention' | 'detached' | 'stopped' | 'failed',
): string => {
  if (profile === 'coding_session') {
    switch (status) {
      case 'pending': return 'Awaiting this run’s one Codex launch.'
      case 'active': return 'Codex is working in a guest COW workspace. Nessie receives no terminal output.'
      case 'attention': return 'Codex exited. The agent can review the COW changes or stop the guest.'
      case 'stopped': return 'Ended. The guest and its transient login material were removed.'
      case 'failed': return 'Ended after an unavailable coding result. This run cannot retry it.'
      case 'detached': return 'Detached from interactive control.'
    }
  }
  if (profile === 'connected_browser') {
    switch (status) {
      case 'pending': return 'Awaiting this run’s first approved browser navigation.'
      case 'active': return 'The run can only observe or act through the approved accessibility tree in this person-approved browser tab.'
      case 'stopped': return 'Ended. This run cannot open another connected-browser session.'
      case 'failed': return 'Ended after an unavailable connected-browser result. This run cannot retry it.'
      case 'attention': return 'Awaiting a human session decision.'
      case 'detached': return 'Detached from interactive control.'
    }
  }
  switch (status) {
    case 'pending':
      return 'Awaiting the run’s first browser navigation.'
    case 'active':
      return 'The run has consumed its one browser navigation; it can only observe or stop this isolated browser.'
    case 'stopped':
      return 'Ended. This run cannot start another browser.'
    case 'failed':
      return 'Ended after an unavailable browser result. This run cannot retry it.'
    case 'attention':
      return 'Awaiting a human session decision.'
    case 'detached':
      return 'Detached from interactive control.'
  }
}

export const ExecutorDetailPanels = ({
  access,
  agents,
  executor,
  onPrepared,
  reviews,
  users,
}: ExecutorDetailPanelsProps) => {
  const [tab, setTab] = useTabParam('tab', EXECUTOR_TAB_VALUES, 'overview')
  const [principalKind, setPrincipalKind] = useState<'user' | 'agent'>('user')
  const [principalId, setPrincipalId] = useState('')
  const [assignmentAction, setAssignmentAction] = useState<'set' | 'remove'>('set')
  const [assignmentRole, setAssignmentRole] = useState<'use' | 'admin'>('use')
  const [grantAgentId, setGrantAgentId] = useState('')
  const [grantOperation, setGrantOperation] = useState<ImplementedExecutorOperationKey>('file.read')
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
        <Pill tone="outline" uppercase={false}>{executor.status}</Pill>
      </div>
      <div className="mt-3 flex">
        <TabBar
          ariaLabel="Executor sections"
          items={EXECUTOR_TABS}
          onChange={setTab}
          size="sm"
          value={tab}
        />
      </div>
      <FormError className="mt-3">{error}</FormError>
      {tab === 'overview' ? (
        <div className="mt-4 grid gap-3 text-sm text-[color:var(--tx2)]">
          <p><span className="font-medium text-[color:var(--tx)]">Profiles:</span> {executor.profiles.join(', ') || 'None approved yet'}</p>
          <p><span className="font-medium text-[color:var(--tx)]">Data boundary:</span> paired executors run only the reviewed local policy. They do not expose host credentials, a host shell, or raw session output to Nessie.</p>
          {(access?.descriptorRevisions ?? []).some((revision) => revision.operationKeys.includes('browser.open')) ? (
            <p><span className="font-medium text-[color:var(--tx)]">Browser origin ceiling:</span> enforced only by the owner’s companion and deliberately not uploaded to Nessie. Confirm the exact site with a human executor administrator before launching a browser run.</p>
          ) : null}
          {(access?.descriptorRevisions ?? []).some((revision) => revision.operationKeys.includes('coding.launch')) ? (
            <p><span className="font-medium text-[color:var(--tx)]">Coding boundary:</span> a managed Codex guest can reach only its fixed ChatGPT origin through the companion gateway. Its owner-private login, tmux control socket, and terminal output never enter Nessie.</p>
          ) : null}
          <p><span className="font-medium text-[color:var(--tx)]">Last seen:</span> {executor.lastSeenAt ?? 'Never'}</p>
          {executor.statusDetail ? <p className="text-xs text-[color:var(--tx3)]">{executor.statusDetail}</p> : null}
          {(access?.descriptorRevisions ?? []).length > 0 ? (
            <div className="grid gap-2 border-t border-[color:var(--sep)] pt-3">
              <SectionLabel size="sm">Local policy proposals</SectionLabel>
              {(access?.descriptorRevisions ?? []).map((revision, index) => (
                <div className="rounded border border-[color:var(--sep)] p-2 text-xs" key={revision.revision}>
                  <p className="font-medium text-[color:var(--tx)]">Revision {revision.revision} · {revision.reviewStatus}</p>
                  <p className="mt-1 text-[color:var(--tx2)]">{revision.profiles.join(', ')} · {revision.operationKeys.join(', ')}</p>
                  <p className="mt-1 break-all text-[color:var(--tx3)]">{revision.localPolicyDigest}</p>
                  {canManage && index === 0 && revision.reviewStatus === 'pending_review' ? (
                    <button
                      className="admin-button admin-button-secondary mt-2"
                      disabled={prepare.isPending}
                      onClick={() => void submitPrepared({
                        kind: 'descriptor_review',
                        revision: revision.revision,
                        status: 'active',
                      })}
                      type="button"
                    >
                      Review activation
                    </button>
                  ) : null}
                  {canManage && index === 0 && revision.reviewStatus === 'active' ? (
                    <button
                      className="admin-button admin-button-secondary mt-2"
                      disabled={prepare.isPending}
                      onClick={() => void submitPrepared({
                        kind: 'descriptor_review',
                        revision: revision.revision,
                        status: 'disabled',
                      })}
                      type="button"
                    >
                      Review disable
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {reviews.length > 0 ? (
            <div className="grid gap-2 border-t border-[color:var(--sep)] pt-3">
              <SectionLabel size="sm">Recent draft reviews</SectionLabel>
              {reviews.slice(0, 3).map((review) => (
                <div className="rounded border border-[color:var(--sep)] p-2 text-xs" key={review.commandId}>
                  <p className="font-medium text-[color:var(--tx)]">{review.changes.length} change{review.changes.length === 1 ? '' : 's'} · {review.acknowledgedAt}</p>
                  <p className="mt-1 break-all text-[color:var(--tx3)]">{review.manifestDigest}</p>
                  <ul className="mt-1 grid gap-0.5 text-[color:var(--tx2)]">
                    {review.changes.map((change) => (
                      <li key={change.path}>
                        {change.kind} · {change.path} · {change.byteCount} bytes
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {tab === 'access' ? (
        <div className="mt-4 grid gap-4">
          <p className="text-sm text-[color:var(--tx2)]">
            Your effective access: private={access?.effectiveAccess.privateAssignment ?? 'unknown'}, project={access?.effectiveAccess.projectRole ?? 'none'}, organization={access?.effectiveAccess.organizationRole ?? 'none'}.
          </p>
          {executor.scope.kind === 'private' && canManage ? (
            <div className="grid gap-2">
              <SectionLabel size="sm">Private assignments</SectionLabel>
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
      {tab === 'sessions' ? (
        <div className="mt-4 grid gap-2 text-sm text-[color:var(--tx2)]">
          <p className="text-xs text-[color:var(--tx3)]">Session records show capability state, never browser content, terminal output, or controls. Open the origin channel when it is available to you; revocation ends all executor activity after a separate human confirmation.</p>
          {(access?.sessions ?? []).length === 0
            ? <p>No executor session has been created.</p>
            : (access?.sessions ?? []).map((session) => (
              <div className="rounded-md border border-[color:var(--sep)] px-3 py-2" key={session.id}>
                <p className="font-medium text-[color:var(--tx)]">{session.profile} · {session.status}</p>
                <p className="mt-0.5 text-xs text-[color:var(--tx2)]">{sessionSummary(session.profile, session.status)}</p>
                <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
                  Created {new Date(session.createdAt).toLocaleString()}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {session.originChannelId ? (
                    <Link className="admin-button admin-button-secondary" to={`/channels/${session.originChannelId}`}>
                      Open origin channel
                    </Link>
                  ) : null}
                  {canManage && (session.status === 'pending' || session.status === 'active') ? (
                    <button
                      className="admin-button admin-button-secondary text-[color:var(--danger-text)]"
                      disabled={prepare.isPending}
                      onClick={() => void submitPrepared({ kind: 'lifecycle', action: 'revoke' })}
                      type="button"
                    >
                      Review revocation to end activity
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
        </div>
      ) : null}
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
