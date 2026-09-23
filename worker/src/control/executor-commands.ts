import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { waitForExecutorCommandResult } from '@nessie/executor-manage'
import type { QueueHandler } from '@nessie/runtime'

import { EXECUTOR_COMMAND_TOPIC } from '../run/executor-toolset.js'

export const ExecutorCommandJobPayloadSchema = z.object({ commandId: z.string().uuid() }).strict()

/**
 * How many `executor.command` jobs one worker process holds at once. A job is
 * held for its command's whole life — up to its TTL — so with a single
 * subscription one machine's two-minute call delayed every other machine's
 * command behind it, and their TTLs ran out in the queue.
 *
 * Each subscription is an independent claim loop. The claim is one
 * `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`
 * (`PgQueueProvider.claimNextJob`), the same statement several worker processes
 * already race on, so no two claimers ever take one job. Each daemon is still
 * delivered at most one leased command at a time
 * (`pollExecutorCommandInTransaction`).
 */
export const EXECUTOR_COMMAND_SUBSCRIPTION_CONCURRENCY = 4

export const subscribeExecutorCommandLanes = (
  subscribe: (topic: string, handler: QueueHandler, options: { signal?: AbortSignal }) => unknown,
  handler: QueueHandler,
  options: { signal?: AbortSignal },
): void => {
  for (let lane = 0; lane < EXECUTOR_COMMAND_SUBSCRIPTION_CONCURRENCY; lane += 1) {
    subscribe(EXECUTOR_COMMAND_TOPIC, handler, options)
  }
}

/** Hold the existing queue lease while the paired daemon owns the command. */
export const executeExecutorCommandJob = async (
  prisma: PrismaClient,
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput,
  payload: unknown,
): Promise<void> => {
  const { commandId } = ExecutorCommandJobPayloadSchema.parse(payload)
  const command = await prisma.executorCommand.findUnique({
    where: { id: commandId },
    select: { payloadExpiresAt: true, state: true },
  })
  if (!command || command.state === 'result_acknowledged' || command.state === 'unknown_outcome') return
  const expiresAt = command.payloadExpiresAt ?? new Date()
  const result = await waitForExecutorCommandResult(prisma, encryptionSecret, commandId, expiresAt)
  if (!result) {
    throw new Error('Executor command outcome is unknown.')
  }
}
