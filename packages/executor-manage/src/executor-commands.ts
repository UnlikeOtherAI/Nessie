import type { Prisma, PrismaClient } from '@prisma/client'
import { ExecutorCommandEnvelopeSchema, type ExecutorCommandEnvelope } from '@nessie/schemas'
import { decryptExecutorCommandJson, encryptExecutorCommandJson, executorCommandDigest } from './executor-command-codec.js'
import { assertExecutorMcpCallPayload } from './executor-coding-session-owner.js'
import { touchExecutorConversationLeaseForBinding } from './executor-conversation-lease.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { assertExecutorCommandBindingCurrent } from './executor-command-fence.js'

export type ExecutorCommandCreateInput = {
  bindingId: string
  commandId: string
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput
  expiresAt: Date
  queueJobId: string
  toolCallId: string
  payload: Record<string, unknown>
}

/**
 * The worker creates the queue job and ToolCall in its own transaction, then
 * persists this protocol record. Queue JSON contains only `commandId`; raw
 * operation arguments live exclusively in this encrypted column.
 *
 * This is the one record of a dispatch, so it is also where a conversation
 * lease's idle window moves: every command under a live lease counts as use.
 * And it is where an `mcp.call` meets the coding-sessions rule: a call to the
 * bridge that the binding's person may not make is refused
 * (`EXECUTOR_CODING_SESSIONS_OWNER_ONLY`), as is any payload whose `owner` is
 * not exactly the binding's (`executor-coding-session-owner.ts`).
 */
export const createExecutorCommand = async (
  prisma: Pick<
    PrismaClient,
    'agentTicketWork' | 'executorAvailabilityCandidate' | 'executorBinding' | 'executorCommand'
    | 'executorConversationLease' | 'executorStandingPolicy'
  >,
  input: ExecutorCommandCreateInput,
): Promise<void> => {
  await assertExecutorMcpCallPayload(prisma, input.bindingId, input.payload)
  await touchExecutorConversationLeaseForBinding(prisma, input.bindingId)
  await prisma.executorCommand.create({
    data: {
      argumentDigest: executorCommandDigest(input.payload),
      bindingId: input.bindingId,
      deliveryPayloadCiphertext: encryptExecutorCommandJson(input.encryptionSecret, input.payload),
      id: input.commandId,
      payloadExpiresAt: input.expiresAt,
      queueJobId: input.queueJobId,
      toolCallId: input.toolCallId,
    },
  })
}

const REFUSED_AT_DELIVERY: ReadonlySet<string> = new Set([
  EXECUTOR_ERROR_CODES.BINDING_FENCED,
  EXECUTOR_ERROR_CODES.CODING_SESSIONS_OWNER_ONLY,
  EXECUTOR_ERROR_CODES.COMMAND_PAYLOAD_INVALID,
])

/** A command that will never be delivered, answered with its terminal result instead. */
const settleUndeliveredCommand = async (
  tx: Prisma.TransactionClient,
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput,
  commandId: string,
  result: Record<string, unknown>,
  now: Date,
): Promise<void> => {
  await tx.executorCommand.updateMany({
    where: { id: commandId, state: 'leased' },
    data: {
      acknowledgedAt: now,
      resultCiphertext: encryptExecutorCommandJson(encryptionSecret, result),
      resultDigest: executorCommandDigest(result),
      state: 'result_acknowledged',
    },
  })
}

/**
 * Daemons see at most one leased command at a time. The linked queue row must
 * already be processing: a queued command is not deliverable merely because a
 * laptop polls quickly.
 */
export const pollExecutorCommandInTransaction = async (
  tx: Prisma.TransactionClient,
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput,
  executorId: string,
  now = new Date(),
): Promise<ExecutorCommandEnvelope | null> => {
    const command = await tx.executorCommand.findFirst({
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
    try {
      const current = await assertExecutorCommandBindingCurrent(
        tx,
        command.bindingId,
        { now },
      )
      if (current.executorId !== executorId) {
        throw new ExecutorError(
          EXECUTOR_ERROR_CODES.BINDING_FENCED,
          'Executor command is no longer bound to this daemon.',
        )
      }
    } catch (error) {
      if (!(error instanceof ExecutorError) || (
        error.code !== EXECUTOR_ERROR_CODES.BINDING_FENCED
        && error.code !== EXECUTOR_ERROR_CODES.NOT_FOUND
      )) {
        throw error
      }
      await settleUndeliveredCommand(tx, encryptionSecret, command.id, {
        code: EXECUTOR_ERROR_CODES.BINDING_FENCED, success: false,
      }, now)
      return null
    }
    const payload = decryptExecutorCommandJson(encryptionSecret, command.deliveryPayloadCiphertext)
    // The coding-sessions rule once more, as the daemon collects the command:
    // a refusal is its result, stated in words the model can pass on, and never
    // a poll failure that would hold every later command behind it.
    try {
      await assertExecutorMcpCallPayload(tx, command.bindingId, payload)
    } catch (error) {
      if (!(error instanceof ExecutorError) || !REFUSED_AT_DELIVERY.has(error.code)) throw error
      await settleUndeliveredCommand(tx, encryptionSecret, command.id, {
        code: error.code, message: error.message, success: false,
      }, now)
      return null
    }
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

export const pollExecutorCommand = async (
  prisma: PrismaClient,
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput,
  executorId: string,
  now = new Date(),
): Promise<ExecutorCommandEnvelope | null> => prisma.$transaction(
  (tx) => pollExecutorCommandInTransaction(tx, encryptionSecret, executorId, now),
)
