import { withSweepLock } from '@nessie/db'
import { publishExpiredExecutorStatuses } from '@nessie/executor-manage'
import type { WorkerSweepDeps } from '../worker-runtime-types.js'

export const startExecutorStatusSweep = (deps: WorkerSweepDeps): (() => void) => {
  let inFlight = false
  const interval = setInterval(() => {
    if (inFlight || deps.abortSignal.aborted) return
    inFlight = true
    void withSweepLock(deps.pool, 'executor-status-expiry', () =>
      publishExpiredExecutorStatuses(deps.prisma, deps.realtimeTransport),
    ).catch((error: unknown) => console.error('[worker.executor-status-expiry] failed', error))
      .finally(() => { inFlight = false })
  }, 10_000)
  return () => clearInterval(interval)
}
