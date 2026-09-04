import { setTimeout as delay } from 'node:timers/promises'

import { Prisma, type ExecutorSessionStatus, type PrismaClient } from '@prisma/client'
import {
  ExecutorCommandReceiptSchema,
  type ExecutorCommandReceipt,
} from '@nessie/schemas'

import {
  decryptExecutorCommandJson,
  encryptExecutorCommandJson,
  executorCommandDigest,
} from './executor-command-codec.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

const MAX_RESULT_BYTES = 65_536

const checkResult = (
  receipt: ExecutorCommandReceipt,
  result: Record<string, unknown> | undefined,
): string | null => {
  if (receipt.state !== 'result_acknowledged') return null
  const encoded = JSON.stringify(result)
  if (
    !result
    || Object.keys(result).length === 0
    || !encoded
    || Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_RESULT_INVALID,
      'Executor result is invalid or exceeds its configured limit.',
    )
  }
  const resultDigest = executorCommandDigest(result)
  if (receipt.resultDigest !== resultDigest) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_RESULT_INVALID,
      'Executor result digest does not match the receipt.',
    )
  }
  return resultDigest
}

const validTransition = (
  current: 'leased' | 'accepted' | 'started' | 'result_acknowledged' | 'unknown_outcome',
  next: ExecutorCommandReceipt['state'],
): boolean => (
  (current === 'leased' && next === 'accepted')
  || (current === 'accepted' && next === 'started')
  || (current === 'started' && next === 'result_acknowledged')
  || (current === 'unknown_outcome' && next === 'result_acknowledged')
)

/** Receipts are monotonic and idempotent only when their terminal digest agrees. */
export const recordExecutorCommandReceiptInTransaction = async (
  tx: Prisma.TransactionClient,
  encryptionSecret: string,
  executorId: string,
  receiptInput: unknown,
  result: Record<string, unknown> | undefined,
): Promise<void> => {
  const receipt = ExecutorCommandReceiptSchema.parse(receiptInput)
  const resultDigest = checkResult(receipt, result)
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor-command:${receipt.commandId}`}, 0))
  `)
  const command = await tx.executorCommand.findUnique({
    where: { id: receipt.commandId },
    include: {
      binding: {
        select: {
          executorId: true,
          operationKey: true,
          sessionId: true,
          session: { select: { profile: true } },
        },
      },
    },
  })
  if (!command || command.binding.executorId !== executorId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor command is unavailable.')
  }
  if (command.state === receipt.state) {
    if (
      receipt.state === 'result_acknowledged'
      && (!resultDigest || command.resultDigest !== resultDigest)
    ) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.COMMAND_REPLAY,
        'A completed executor command cannot receive a different result.',
      )
    }
    return
  }
  if (!validTransition(command.state, receipt.state)) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_REPLAY,
      'Executor command receipt is stale or out of order.',
    )
  }
  const occurredAt = new Date(receipt.occurredAt)
  await tx.executorCommand.update({
    where: { id: command.id },
    data: {
      ...(receipt.state === 'accepted' ? { acceptedAt: occurredAt } : {}),
      ...(receipt.state === 'started' ? { startedAt: occurredAt } : {}),
      ...(receipt.state === 'result_acknowledged'
        ? {
            acknowledgedAt: occurredAt,
            resultCiphertext: encryptExecutorCommandJson(encryptionSecret, result),
            resultDigest,
          }
        : {}),
      state: receipt.state,
    },
  })
  let terminalSessionState: 'attention' | 'failed' | 'stopped' | null = null
  const sessionId = command.binding.sessionId
  if (receipt.state === 'result_acknowledged' && sessionId) {
    if (command.binding.operationKey === 'sandbox.stop') {
      terminalSessionState = 'stopped'
    } else if (
      (
        command.binding.operationKey === 'browser.open'
        || command.binding.operationKey === 'browser.observe'
        || command.binding.operationKey === 'browser.act'
      )
      && result?.success !== true
    ) {
      terminalSessionState = 'failed'
    } else if (
      command.binding.session?.profile === 'coding_session'
      && command.binding.operationKey === 'coding.launch'
      && result?.success !== true
    ) {
      terminalSessionState = 'failed'
    } else if (
      command.binding.session?.profile === 'coding_session'
      && command.binding.operationKey === 'coding.observe'
      && result?.success === true
      && result.lifecycle === 'exited'
    ) {
      terminalSessionState = 'attention'
    }
  }
  if (terminalSessionState && sessionId) {
    const eligibleStatuses: ExecutorSessionStatus[] = terminalSessionState === 'stopped'
      ? ['pending', 'active', 'attention', 'detached']
      : terminalSessionState === 'attention'
        ? ['active']
        : ['pending', 'active']
    await tx.executorSession.updateMany({
      where: {
        executorId,
        id: sessionId,
        status: { in: eligibleStatuses },
      },
      data: { status: terminalSessionState },
    })
  }
}

export const recordExecutorCommandReceipt = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  executorId: string,
  receiptInput: unknown,
  result: Record<string, unknown> | undefined,
): Promise<void> => prisma.$transaction(
  (tx) => recordExecutorCommandReceiptInTransaction(
    tx,
    encryptionSecret,
    executorId,
    receiptInput,
    result,
  ),
)

export const readExecutorCommandResult = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  commandId: string,
): Promise<Record<string, unknown> | null> => {
  const command = await prisma.executorCommand.findUnique({
    where: { id: commandId },
    select: { resultCiphertext: true, state: true },
  })
  if (command?.state !== 'result_acknowledged' || !command.resultCiphertext) return null
  return decryptExecutorCommandJson(encryptionSecret, command.resultCiphertext)
}

/**
 * A waiting worker never converts silence into success. The state is durable so
 * a later operator can distinguish "not known" from a rejected command.
 */
export const markExecutorCommandUnknownOutcome = async (
  prisma: PrismaClient,
  commandId: string,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`executor-command:${commandId}`}, 0))
    `)
    await tx.executorCommand.updateMany({
      where: {
        id: commandId,
        state: { in: ['leased', 'accepted', 'started'] },
      },
      data: { state: 'unknown_outcome' },
    })
  })
}

const readResultOrMarkUnknownOutcome = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  commandId: string,
): Promise<Record<string, unknown> | null> => prisma.$transaction(async (tx) => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor-command:${commandId}`}, 0))
  `)
  const command = await tx.executorCommand.findUnique({
    where: { id: commandId },
    select: { resultCiphertext: true, state: true },
  })
  if (command?.state === 'result_acknowledged' && command.resultCiphertext) {
    return decryptExecutorCommandJson(encryptionSecret, command.resultCiphertext)
  }
  await tx.executorCommand.updateMany({
    where: {
      id: commandId,
      state: { in: ['leased', 'accepted', 'started'] },
    },
    data: { state: 'unknown_outcome' },
  })
  return null
})

export const waitForExecutorCommandResult = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  commandId: string,
  expiresAt: Date,
): Promise<Record<string, unknown> | null> => {
  while (new Date() < expiresAt) {
    const result = await readExecutorCommandResult(prisma, encryptionSecret, commandId)
    if (result) return result
    await delay(250)
  }
  return readResultOrMarkUnknownOutcome(prisma, encryptionSecret, commandId)
}
