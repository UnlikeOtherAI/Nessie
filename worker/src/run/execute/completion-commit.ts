import { Prisma, type PrismaClient } from '@prisma/client'
import { QueueRetryAfterError } from '@nessie/runtime'

import {
  currentExecutorToken,
  releaseExecutorFence,
  RunFencedError,
} from './lifecycle.js'
import { cleanupRunResumeState } from './terminal-cleanup.js'

/**
 * Commit the answer-specific writes and successful terminal state as one unit.
 * The callback also inserts the keyed follow-up queue row. Nothing outside the
 * transaction can observe an answer without `completed`, or `completed`
 * without the durable intent that finishes its required side effects.
 */
const UNCERTAIN_COMMIT_RETRY_MS = 1_000

const verifySuccessfulCommit = async (
  prisma: PrismaClient,
  runId: string,
): Promise<boolean> => prisma.$transaction(async (tx) => {
  // This lock is the settlement barrier for an ambiguous COMMIT. It cannot be
  // granted while the original terminal transaction still owns the run row,
  // so the follow-up read below observes the same committed decision rather
  // than racing it on a second connection.
  const rows = await tx.$queryRaw<Array<{ status: string }>>(
    Prisma.sql`
      SELECT status::text AS status
      FROM runs
      WHERE id = ${runId}::uuid
      FOR UPDATE
    `,
  )
  if (rows[0]?.status !== 'completed') return false

  const followup = await tx.queueJob.findUnique({
    select: { id: true },
    where: { idempotencyKey: `run-completion-followup:${runId}` },
  })
  return followup !== null
})

export const commitSuccessfulRun = async (
  prisma: PrismaClient,
  input: { agentId: string; completedAt: Date; runId: string; taskId: string },
  writeAnswerAndFollowup: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> => {
  const token = currentExecutorToken(input.runId)
  if (!token) throw new RunFencedError(input.runId)

  try {
    await prisma.$transaction(async (tx) => {
      await writeAnswerAndFollowup(tx)

      const { count } = await tx.run.updateMany({
        data: {
          finishedAt: input.completedAt,
          status: 'completed',
        },
        where: {
          executorToken: token,
          id: input.runId,
          status: 'running',
        },
      })
      if (count !== 1) throw new RunFencedError(input.runId)

      // Clear resumable state after the conditional terminal write proves this
      // transaction owns the run, but before shedding its token. A takeover may
      // finish before writing its first checkpoint, in which case the checkpoint
      // still carries the previous executor's token and can only be cleared
      // through the run-row fence.
      await cleanupRunResumeState(tx, input.runId, {
        executorToken: token,
        mode: 'required',
      })
      const released = await tx.run.updateMany({
        data: { executorHeartbeatAt: null, executorToken: null },
        where: { executorToken: token, id: input.runId, status: 'completed' },
      })
      if (released.count !== 1) throw new RunFencedError(input.runId)
      await tx.task.update({
        data: { status: 'done' },
        where: { id: input.taskId },
      })
      // This write is inside the terminal transaction, so a later replay of the
      // follow-up can never turn a newer run's thinking/executing state idle.
      await tx.agent.update({
        data: { status: 'idle' },
        where: { id: input.agentId },
      })
    })
  } catch (transactionError) {
    // COMMIT can succeed while its acknowledgement is lost. Before the generic
    // failure path posts an error answer, wait on the run row and read the
    // atomic decision back in one transaction. The keyed follow-up is part of
    // that decision, so both facts prove success.
    try {
      if (await verifySuccessfulCommit(prisma, input.runId)) {
        releaseExecutorFence(input.runId)
        return
      }
    } catch (readError) {
      throw new QueueRetryAfterError(
        `Run completion commit for ${input.runId} could not be verified`,
        UNCERTAIN_COMMIT_RETRY_MS,
        { cause: new AggregateError([transactionError, readError]) },
      )
    }
    throw transactionError
  }

  releaseExecutorFence(input.runId)
}
