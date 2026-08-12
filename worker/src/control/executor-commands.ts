import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { waitForExecutorCommandResult } from '@nessie/executor-manage'

export const ExecutorCommandJobPayloadSchema = z.object({ commandId: z.string().uuid() }).strict()

/** Hold the existing queue lease while the paired daemon owns the command. */
export const executeExecutorCommandJob = async (
  prisma: PrismaClient,
  encryptionSecret: string,
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
