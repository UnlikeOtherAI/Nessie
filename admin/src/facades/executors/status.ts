import type { ExecutorRecordResponse } from '@nessie/schemas'

export const executorGroupStatus = (executors: Pick<ExecutorRecordResponse, 'status'>[]) => {
  const online = executors.filter((executor) => executor.status === 'online').length
  if (executors.length === 0) return { label: 'No executors', token: '--tx3' }
  if (online === executors.length) return { label: 'All executors online', token: '--success' }
  if (online === 0) return { label: 'All executors offline', token: '--danger' }
  return { label: 'Some executors offline', token: '--warning' }
}
