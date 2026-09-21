import type { ExecutorAgentAccessRecord } from '@nessie/schemas'
import { usePagedList } from '../pagination/usePagedList'
import { executorKeys } from './keys'

/** The server joins assignment and grants before paging, so an agent occupies one row. */
export const useExecutorAgents = (executorId: string, query: string) => usePagedList<ExecutorAgentAccessRecord>({
  params: { q: query.trim() || undefined },
  paramPrefix: 'executor-agent-',
  path: `/api/executors/${executorId}/agents`,
  queryKey: executorKeys.agents(executorId),
  scope: executorId,
})

export const useExecutorAgentCandidates = (executorId: string, query: string) => (
  usePagedList<ExecutorAgentAccessRecord>({
    params: { q: query.trim() || undefined },
    paramPrefix: 'executor-add-',
    path: `/api/executors/${executorId}/agent-candidates`,
    queryKey: executorKeys.agentCandidates(executorId),
    scope: executorId,
  })
)
