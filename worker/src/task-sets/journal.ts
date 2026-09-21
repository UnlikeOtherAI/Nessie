import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { taskSetJson } from '@nessie/team-admin'
import { RunFencedError } from '../run/execute/lifecycle.js'
import { TaskSetBlocked } from './state.js'
import type { TaskSetClaim } from './processor.js'

export const assertTaskSetFence = async (
  tx: Prisma.TransactionClient, claim: TaskSetClaim, fence: string,
): Promise<void> => {
  // The no-op UPDATE locks the run as well as checking the fence, so takeover
  // cannot pass between validation and a journal/result commit.
  const owned = await tx.run.updateMany({
    where: { id: claim.attempt.runId, executorToken: fence, status: 'running' },
    data: { executorHeartbeatAt: new Date() },
  })
  if (owned.count !== 1) throw new RunFencedError(claim.attempt.runId)
}

/** Completed steps replay without calling a processor or search again. */
export const taskSetJournalStep = async <T>(input: {
  prisma: PrismaClient; claim: TaskSetClaim; fence: string; sequence: number;
  request: unknown; recoverable: boolean; execute: () => Promise<T>;
}): Promise<T> => {
  const inputHash = createHash('sha256').update(JSON.stringify(input.request)).digest('hex')
  const previous = await input.prisma.$transaction(async (tx) => {
    await assertTaskSetFence(tx, input.claim, input.fence)
    const where = { attemptId_sequence: { attemptId: input.claim.attempt.id, sequence: input.sequence } }
    const row = await tx.taskSetStep.findUnique({ where })
    if (row && row.inputHash !== inputHash) throw new TaskSetBlocked('processor_checkpoint_changed')
    if (row) return row
    await tx.taskSetStep.create({ data: {
      attemptId: input.claim.attempt.id, sequence: input.sequence, inputHash,
    } })
    return null
  })
  if (previous?.completedAt) return previous.result as T
  if (previous && !input.recoverable) throw new TaskSetBlocked('processor_outcome_unknown')
  const result = await input.execute()
  await input.prisma.$transaction(async (tx) => {
    await assertTaskSetFence(tx, input.claim, input.fence)
    await tx.taskSetStep.update({
      where: { attemptId_sequence: { attemptId: input.claim.attempt.id, sequence: input.sequence } },
      data: { result: taskSetJson(result), completedAt: new Date() },
    })
  })
  return result
}
