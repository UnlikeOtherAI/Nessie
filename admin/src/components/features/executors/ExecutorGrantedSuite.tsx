import { executorWholeSuiteOperationKeys } from '@nessie/schemas'
import { useAgents } from '../../../facades/agents/hooks'
import { useExecutorAccess } from '../../../facades/executors/hooks'

/**
 * What an `agent_executor_grant` actually hands over, in words.
 *
 * A prepared change is stored and returned as an opaque record, and this one
 * names no operation key at all — the whole point is that access to an
 * executor is access to everything on it, so the set is derived when the
 * change is applied. That makes it the one kind whose JSON tells a person
 * nothing: `{"kind":"agent_executor_grant","agentId":"…","state":"allowed"}`
 * is a bare kind string and a uuid. So the agent is named, and every operation
 * it is about to be able to run is listed, from the same active revision the
 * server will derive the set from.
 *
 * It renders nothing for any other kind. When the executor's access view
 * cannot be read it says the operations could not be listed rather than
 * showing a shorter list, because a person who confirms a grant having been
 * shown four of eleven operations has been told something false.
 */
export type ExecutorGrantedSuiteProps = {
  change: Record<string, unknown>
  executorId: string
}

export const ExecutorGrantedSuite = ({ change, executorId }: ExecutorGrantedSuiteProps) => {
  const isWholeSuiteGrant = change.kind === 'agent_executor_grant'
  const accessQuery = useExecutorAccess(isWholeSuiteGrant ? executorId : undefined)
  const agentsQuery = useAgents()
  if (!isWholeSuiteGrant) return null

  const agentId = typeof change.agentId === 'string' ? change.agentId : ''
  const agentName = (agentsQuery.data ?? []).find((agent) => agent.id === agentId)?.name ?? agentId
  const allowed = change.state === 'allowed'
  // The latest revision, and only when it is active — the definition the
  // daemon enforces. A superseded revision keeps its `active` row, so picking
  // the highest-numbered active one would list operations this executor will
  // refuse, on the screen somebody reads before authorising the grant.
  const latest = [...(accessQuery.data?.descriptorRevisions ?? [])]
    .sort((left, right) => right.revision - left.revision)[0]
  const active = latest?.reviewStatus === 'active' ? latest : undefined
  const operationKeys = active
    ? executorWholeSuiteOperationKeys(active.operationKeys)
    : null

  return (
    <div className="grid gap-1 rounded border border-[color:var(--sep)] p-2 text-xs">
      <p className="font-medium text-[color:var(--tx)]">
        {allowed
          ? `Give ${agentName} everything this executor offers`
          : `Take away everything this executor offers from ${agentName}`}
      </p>
      <p className="text-[color:var(--tx2)]">
        {allowed
          ? 'An executor grant is whole-suite: this agent will be able to run every operation '
            + 'the executor’s active reviewed policy names, not a selection of them. Promoting a '
            + 'reviewed draft back to the host is never included — only a person can issue that.'
          : 'This denies the same whole suite, so the agent keeps no operation on this executor.'}
      </p>
      {operationKeys === null ? (
        <p className="text-[color:var(--tx3)]">
          {accessQuery.isError
            ? 'The operations could not be listed here because this executor’s access could not be '
              + 'read. Open the executor before confirming.'
            : accessQuery.isPending
              ? 'Listing the operations…'
              : 'This executor has no active reviewed policy, so it offers nothing to grant and '
                + 'confirming will be refused.'}
        </p>
      ) : (
        <ul className="grid gap-0.5 text-[color:var(--tx2)]">
          {operationKeys.map((operationKey) => <li key={operationKey}>{operationKey}</li>)}
        </ul>
      )}
    </div>
  )
}
