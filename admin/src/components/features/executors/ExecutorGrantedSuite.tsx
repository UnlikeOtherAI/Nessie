import { executorWholeSuiteOperationKeys } from '@nessie/schemas'
import { useExecutorAccess } from '../../../facades/executors/hooks'
import { ExecutorPermissionDetails } from './ExecutorReviewedPolicy'

export type ExecutorGrantedSuiteProps = { change: Record<string, unknown>; executorId: string }

/** Enumerates the same current permission set the server will grant. */
export const ExecutorGrantedSuite = ({ change, executorId }: ExecutorGrantedSuiteProps) => {
  const whole = change.kind === 'agent_executor_grant' || change.kind === 'agent_executor_access'
  const accessQuery = useExecutorAccess(whole ? executorId : undefined)
  if (!whole || change.state !== 'allowed') return null
  const access = accessQuery.data?.executorId === executorId ? accessQuery.data : undefined
  const latest = [...(access?.descriptorRevisions ?? [])].sort((a, b) => b.revision - a.revision)[0]
  const operations = latest?.reviewStatus === 'active' ? executorWholeSuiteOperationKeys(latest.operationKeys) : null
  return operations && latest ? (
    <div className="grid gap-2 text-sm text-[color:var(--tx2)]">
      <ExecutorPermissionDetails revision={{ ...latest, operationKeys: operations }} />
      {latest?.operationKeys.includes('workspace.promote') ? <p>Applying draft changes to the machine still requires a person’s approval.</p> : null}
    </div>
  ) : <p className="text-sm text-[color:var(--tx3)]">
    {accessQuery.isError ? 'The machine’s permissions could not be loaded.' : accessQuery.isPending ? 'Loading permissions…' : 'Approve the machine’s permissions before adding an agent.'}
  </p>
}
