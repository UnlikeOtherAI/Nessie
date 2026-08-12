import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import {
  canonicalExecutorJson,
  ExecutorCommandEnvelopeSchema,
  ExecutorCommandReceiptSchema,
  type ExecutorCommandEnvelope,
  type ExecutorCommandReceipt,
} from '@nessie/schemas'
import { decryptWithKey, deriveSecretKey, encryptWithKey } from '@nessie/runtime'

import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

const MAX_RESULT_BYTES = 65_536

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

const encryptJson = (encryptionSecret: string, value: unknown): string =>
  JSON.stringify(encryptWithKey(deriveSecretKey(encryptionSecret), JSON.stringify(value)))

const decryptJson = (encryptionSecret: string, ciphertext: string): Record<string, unknown> => {
  try {
    const parts = JSON.parse(ciphertext) as {
      authTag: string
      ciphertext: string
      iv: string
    }
    const parsed = JSON.parse(decryptWithKey(deriveSecretKey(encryptionSecret), parts))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a record')
    return parsed as Record<string, unknown>
  } catch {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_PAYLOAD_INVALID,
      'Executor command payload cannot be read.',
    )
  }
}

export type ExecutorCommandCreateInput = {
  bindingId: string
  commandId: string
  encryptionSecret: string
  expiresAt: Date
  queueJobId: string
  toolCallId: string
  payload: Record<string, unknown>
}

/**
 * The worker creates the queue job and ToolCall in its own transaction, then
 * persists this protocol record. Queue JSON contains only `commandId`; raw
 * operation arguments live exclusively in this encrypted column.
 */
export const createExecutorCommand = async (
  prisma: PrismaClient,
  input: ExecutorCommandCreateInput,
): Promise<void> => {
  await prisma.executorCommand.create({
    data: {
      argumentDigest: digest(input.payload),
      bindingId: input.bindingId,
      deliveryPayloadCiphertext: encryptJson(input.encryptionSecret, input.payload),
      id: input.commandId,
      payloadExpiresAt: input.expiresAt,
      queueJobId: input.queueJobId,
      toolCallId: input.toolCallId,
    },
  })
}

/**
 * Daemons see at most one leased command at a time. The linked queue row must
 * already be processing: a queued command is not deliverable merely because a
 * laptop polls quickly.
 */
export const pollExecutorCommand = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  executorId: string,
  now = new Date(),
): Promise<ExecutorCommandEnvelope | null> => {
  const command = await prisma.executorCommand.findFirst({
    where: {
      binding: { executorId },
      payloadExpiresAt: { gt: now },
      queueJob: { status: 'processing' },
      state: 'leased',
    },
    include: {
      binding: {
        include: {
          capabilityRevision: { select: { revision: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!command?.deliveryPayloadCiphertext || !command.payloadExpiresAt) return null
  const payload = decryptJson(encryptionSecret, command.deliveryPayloadCiphertext)
  return ExecutorCommandEnvelopeSchema.parse({
    argumentDigest: command.argumentDigest,
    bindingFence: command.binding.fence.toString(),
    bindingId: command.bindingId,
    capabilityRevision: command.binding.capabilityRevision.revision,
    commandId: command.id,
    expiresAt: command.payloadExpiresAt.toISOString(),
    idempotencyKey: command.toolCallId,
    operationKey: command.binding.operationKey,
    payload,
  })
}

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
  const resultDigest = digest(result)
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
)

/** Receipts are monotonic and idempotent only when their terminal digest agrees. */
export const recordExecutorCommandReceipt = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  executorId: string,
  receiptInput: unknown,
  result: Record<string, unknown> | undefined,
): Promise<void> => {
  const receipt = ExecutorCommandReceiptSchema.parse(receiptInput)
  const resultDigest = checkResult(receipt, result)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`executor-command:${receipt.commandId}`}, 0))
    `)
    const command = await tx.executorCommand.findUnique({
      where: { id: receipt.commandId },
      include: { binding: { select: { executorId: true } } },
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
              resultCiphertext: encryptJson(encryptionSecret, result),
              resultDigest,
            }
          : {}),
        state: receipt.state,
      },
    })
  })
}

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
  return decryptJson(encryptionSecret, command.resultCiphertext)
}
