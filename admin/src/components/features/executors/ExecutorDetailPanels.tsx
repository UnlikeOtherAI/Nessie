import type { UseQueryResult } from '@tanstack/react-query'
import { ApiClientError } from '@nessie/client-core'
import type { ExecutorRecordResponse, PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import type { ExecutorAccessViewWithLocalMcp } from '../../../facades/executors/local-mcp'
import { useTabParam } from '../../../navigation/useTabParam'
import { TabBar } from '../../primitives/TabBar'
import { QueryState } from '../../shared/QueryState'
import { ExecutorAgentsPanel } from './ExecutorAgentsPanel'
import { ExecutorPermissionsPanel } from './ExecutorPermissionsPanel'
import { ExecutorActivityPanel } from './ExecutorActivityPanel'
import { ExecutorLeasesPanel } from './ExecutorLeasesPanel'
import { ExecutorHostSessionList } from './ExecutorHostSessionList'
import { ExecutorStandingAccessPanel } from './ExecutorStandingAccessPanel'

export const EXECUTOR_TAB_VALUES = ['agents', 'sessions', 'permissions', 'activity'] as const
export type ExecutorTab = (typeof EXECUTOR_TAB_VALUES)[number]
export const EXECUTOR_TABS = [
  { label: 'Agents', value: 'agents' },
  { label: 'Sessions', value: 'sessions' },
  { label: 'Permissions', value: 'permissions' },
  { label: 'Activity', value: 'activity' },
] as const

export const accessErrorLabel = (error: unknown): string =>
  error instanceof ApiClientError && error.code === 'INVALID_RESPONSE'
    ? 'This Nessie is older than the server it is talking to, so it cannot read this '
      + 'executor’s access. Update or reinstall Nessie Desktop.'
    : 'This executor’s access could not be loaded.'

type ExecutorDetailPanelsProps = {
  accessQuery: UseQueryResult<ExecutorAccessViewWithLocalMcp>
  executor: ExecutorRecordResponse
  onPrepared: (prepared: PreparedExecutorAccessChangeResponse) => void
  token?: string | null
}

export const ExecutorDetailPanels = ({
  accessQuery, executor, onPrepared, token = null,
}: ExecutorDetailPanelsProps) => {
  const [tab, setTab] = useTabParam('tab', EXECUTOR_TAB_VALUES, 'agents')
  // A previous machine's cached result must never describe this one's grants.
  const access = accessQuery.data?.executorId === executor.id ? accessQuery.data : undefined
  const latest = [...(access?.descriptorRevisions ?? [])].sort((a, b) => b.revision - a.revision)[0]
  const pendingReview = access?.canManage && latest?.reviewStatus === 'pending_review'
    && !['revoked', 'pending_pairing'].includes(executor.status)
  const tabs = EXECUTOR_TABS.map((item) => ({
    ...item,
    ...(item.value === 'permissions' && pendingReview ? { count: 1, title: 'One change to review' } : {}),
  }))
  return (
    <div className="grid min-h-0 gap-5">
      <div className="flex"><TabBar ariaLabel="Executor sections" items={tabs} onChange={setTab} size="sm" touchTarget value={tab} /></div>
      <QueryState className="py-6" errorLabel={accessErrorLabel(accessQuery.error)} loadingLabel="Loading executor…" query={accessQuery}>
        {() => access ? access.canManage ? (
          <>
            {tab === 'agents' ? <ExecutorAgentsPanel executorId={executor.id} scopeKind={executor.scope.kind} onPrepared={onPrepared} token={token} /> : null}
            {tab === 'permissions' ? <ExecutorPermissionsPanel access={access} onPrepared={onPrepared} /> : null}
            {tab === 'sessions' ? <ExecutorHostSessionList executorId={executor.id} /> : null}
            {tab === 'activity' ? (
              <div className="grid gap-6">
                <ExecutorLeasesPanel executorId={executor.id} />
                {executor.scope.kind === 'private' ? <ExecutorStandingAccessPanel executorId={executor.id} /> : null}
                <section aria-labelledby="executor-sessions-heading" className="grid gap-3">
                  <h2 className="text-sm font-semibold text-[color:var(--tx)]" id="executor-sessions-heading">Recent sessions</h2>
                  <ExecutorActivityPanel sessions={access.sessions ?? []} />
                </section>
              </div>
            ) : null}
          </>
        ) : <p className="text-sm text-[color:var(--tx2)]">Only this machine’s administrators can manage its agents and permissions.</p> : null}
      </QueryState>
    </div>
  )
}
