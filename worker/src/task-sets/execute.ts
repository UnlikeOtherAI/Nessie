import { releaseLocalInferenceResource, type FileService } from '@nessie/runtime'
import { AuthorizedActionContextSchema, TaskSetSourceSchema } from '@nessie/schemas'
import {
  assertTaskSetActor, assertTaskSetDisclosure, authorizeTaskSetSource,
  enqueueTaskSet, lockTaskSet, taskSetJson, TaskSetError,
} from '@nessie/team-admin'
import {
  claimRunForExecution, RunFencedError, startExecutorHeartbeat, withRunExecutorFence,
} from '../run/execute/lifecycle.js'
import { claimTaskSetItem } from './admission.js'
import { importTaskSetSource } from './import.js'
import { assertTaskSetFence } from './journal.js'
import { processTaskSetItem, type TaskSetClaim, type TaskSetProcessorDeps } from './processor.js'
import { changeTaskSetHealth, TaskSetBlocked, TaskSetWait } from './state.js'
import { finalizeTaskSet } from './finalize.js'
import { buildTaskSetSearchTools } from './search.js'

type Deps = TaskSetProcessorDeps & { fileService: FileService }
type Outcome = { result: string; disclosure: unknown } | { reason: string; waiting: boolean; offline?: boolean }

/** Cursor, result, run and next wakeup commit together under the current fence. */
export const settleTaskSetItem = async (
  deps: Pick<Deps, 'prisma'>, claim: TaskSetClaim, fence: string, outcome: Outcome,
): Promise<boolean> => deps.prisma.$transaction(async (tx) => {
  await lockTaskSet(tx, claim.set.id)
  await assertTaskSetFence(tx, claim, fence)
  const set = await tx.taskSet.findUniqueOrThrow({ where: { id: claim.set.id } })
  const item = await tx.taskSetItem.findUniqueOrThrow({ where: { id: claim.item.id } })
  if (set.currentItemId !== item.id || item.currentAttemptId !== claim.attempt.id) throw new RunFencedError(claim.attempt.runId)
  const run = await tx.run.findUniqueOrThrow({ where: { id: claim.attempt.runId } })
  if (run.inferenceResourceAdmissionId) {
    const released = await releaseLocalInferenceResource(tx, { admissionId: run.inferenceResourceAdmissionId })
    if (!released) {
      // Receipt confirmation, not a lease timeout, releases a local slot.
      await tx.taskSetAttempt.update({ where: { id: claim.attempt.id }, data: {
        status: 'settling', reason: JSON.stringify(outcome), statusChangedAt: new Date(),
      } })
      await tx.run.update({ where: { id: run.id }, data: { status: 'pending', executorToken: null, executorHeartbeatAt: null } })
      await tx.taskSet.update({ where: { id: set.id }, data: { nextAttemptAt: new Date(Date.now() + 30_000) } })
      return false
    }
  }
  const now = new Date()
  const success = 'result' in outcome
  const stopped = ['paused', 'cancelled'].includes(set.status)
  const failures = await tx.taskSetAttempt.count({ where: {
    itemId: item.id, number: { gt: item.retryBase }, status: 'failed',
  } })
  const retry = !success && outcome.waiting || !success
    && outcome.reason === 'processor_failed' && failures + 1 < set.maxAttempts
  await tx.taskSetAttempt.update({ where: { id: claim.attempt.id }, data: {
    status: success ? 'completed' : outcome.waiting || stopped ? 'interrupted' : 'failed',
    reason: success ? null : outcome.reason, statusChangedAt: now,
  } })
  await tx.run.update({ where: { id: run.id }, data: {
    status: success ? 'completed' : stopped ? 'cancelled' : 'failed', finishedAt: now,
    executorToken: null, executorHeartbeatAt: null,
  } })
  await tx.task.update({ where: { id: claim.attempt.taskId }, data: {
    status: success ? 'done' : stopped ? 'cancelled' : 'failed',
  } })
  await tx.taskSetItem.update({ where: { id: item.id }, data: {
    currentAttemptId: null, statusChangedAt: now,
    status: success ? 'completed' : stopped || retry ? 'pending' : 'failed',
    reason: success ? null : outcome.reason,
    ...(success ? { result: outcome.result, resultDisclosure: taskSetJson(outcome.disclosure) } : {}),
  } })
  const delayMs = success ? 0 : Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6))
  const updated = await tx.taskSet.update({ where: { id: set.id }, data: {
    currentItemId: null, revision: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + delayMs),
    ...(success ? { nextSequence: { increment: 1 }, completedItems: { increment: 1 },
      ...(!stopped ? { status: 'running', reason: null, offlineSince: null } : {}) } : {}),
  } })
  if (!stopped && (success || retry)) await enqueueTaskSet(tx, set.id, updated.revision, delayMs)
  return true
})

const classify = (error: unknown): Exclude<Outcome, { result: string }> => {
  if (error instanceof TaskSetWait) return { reason: error.reason, waiting: true, offline: error.offline }
  if (error instanceof TaskSetBlocked) return { reason: error.reason, waiting: false }
  if (error instanceof TaskSetError) return { reason: error.code.toLowerCase(), waiting: false }
  // Raw provider messages can contain prompts or credentials. The persisted
  // remedy is structural; diagnostic data stays in the provider's own journal.
  return { reason: 'processor_failed', waiting: false }
}

export const executeTaskSet = async (deps: Deps, id: string, signal?: AbortSignal): Promise<void> => {
  let claim: TaskSetClaim | null = null
  try {
    const set = await deps.prisma.taskSet.findUnique({ where: { id } })
    if (!set) return
    if (set.status === 'completed') {
      if (set.deliveryStatus === 'pending') await finalizeTaskSet(deps, id)
      return
    }
    if (!['running', 'waiting', 'importing'].includes(set.status) && !set.currentItemId) return
    const authorize = async () => {
      const actor = AuthorizedActionContextSchema.parse(set.launchOrigin)
      await assertTaskSetActor(deps.prisma, actor)
      await assertTaskSetDisclosure(deps.prisma, actor, set.disclosure)
      if (!set.source) return
      const source = await authorizeTaskSetSource(deps.prisma, actor, TaskSetSourceSchema.parse(set.source), {
        processingAgentId: set.executionAgentId,
      })
      if (source.attachmentId !== set.sourceAttachmentId) throw new TaskSetBlocked('source_revision_changed')
    }
    if (!set.currentItemId) await authorize()
    if (set.status === 'importing') { await importTaskSetSource(deps.prisma, deps.fileService, id, signal); return }
    const admitted = await claimTaskSetItem(deps.prisma, id)
    if (!admitted) { await finalizeTaskSet(deps, id); return }
    if ('blocked' in admitted) throw new TaskSetBlocked(admitted.blocked)
    claim = admitted
    await withRunExecutorFence(claim.attempt.runId, async () => {
      const execution = await claimRunForExecution(deps.prisma, admitted.attempt.runId)
      if (!execution.claimed) return
      const heartbeat = startExecutorHeartbeat(deps.prisma, admitted.attempt.runId)
      try {
        let outcome: Outcome
        if (admitted.attempt.status === 'settling' && admitted.attempt.reason) {
          outcome = JSON.parse(admitted.attempt.reason) as Outcome
        } else {
          try {
            if (['paused', 'cancelled'].includes(admitted.set.status)) throw new TaskSetWait('paused')
            await authorize()
            outcome = await processTaskSetItem({
              ...deps, searchTools: deps.searchTools ?? ((entry, context) => buildTaskSetSearchTools(deps, entry, context)),
            }, admitted, execution.token, signal)
          } catch (error) {
            if (error instanceof RunFencedError || signal?.aborted) throw error
            outcome = classify(error)
          }
        }
        const settled = await settleTaskSetItem(deps, admitted, execution.token, outcome)
        if (!settled) {
          await changeTaskSetHealth(deps.prisma, id, { reason: 'waiting_for_stop_confirmation', waiting: true })
        } else if ('reason' in outcome) {
          const failures = await deps.prisma.taskSetAttempt.count({ where: {
            itemId: admitted.item.id, number: { gt: admitted.item.retryBase }, status: 'failed',
          } })
          const retry = outcome.waiting || outcome.reason === 'processor_failed' && failures < admitted.set.maxAttempts
          await changeTaskSetHealth(deps.prisma, id, { ...outcome, waiting: retry })
        }
      } finally { heartbeat.stop() }
    })
  } catch (error) {
    if (error instanceof RunFencedError || signal?.aborted) return
    if (claim) throw error // failed database commits must replay; never advance on an uncertain commit
    await changeTaskSetHealth(deps.prisma, id, classify(error))
  }
}
