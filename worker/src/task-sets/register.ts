import { z } from 'zod'
import type { WorkerCoreSubscriptionDeps, WorkerSweepDeps } from '../worker-runtime-types.js'
import { executeTaskSet } from './execute.js'
import { sweepTaskSets } from './state.js'

export const registerTaskSetWorker = (deps: WorkerCoreSubscriptionDeps): void => {
  deps.subscribe('task_set.execute', async (job, { signal }) => {
    const { taskSetId } = z.object({ taskSetId: z.string().uuid() }).parse(job.payload)
    await executeTaskSet({
      prisma: deps.prisma, fileService: deps.fileService,
      modelClient: deps.modelClient, ledgerIdentity: deps.ledgerIdentity,
      atRestEncryptionKeyRing: deps.encryptionKeyRing, executorCommandEncryptionSecret: deps.encryptionKeyRing,
      queueProvider: deps.queueProvider, realtimeTransport: deps.realtimeTransport,
      subscriptionSecrets: deps.subscriptionSecrets, searchConfig: { modelClient: deps.modelClient, pool: deps.pool },
    }, taskSetId, signal)
  }, { signal: deps.abortSignal })
}

export const startTaskSetSweep = (deps: WorkerSweepDeps): (() => void) => {
  let busy = false
  const timer = setInterval(() => {
    if (busy || deps.abortSignal.aborted) return
    busy = true
    void sweepTaskSets(deps.prisma)
      .catch((error: unknown) => console.error('[worker.task-set-sweep] failed', error))
      .finally(() => { busy = false })
  }, 15_000)
  timer.unref()
  return () => clearInterval(timer)
}
