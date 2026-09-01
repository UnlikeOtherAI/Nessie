import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { Prisma, type ExecutorSessionStatus, type PrismaClient } from '@prisma/client'
import {
  canonicalExecutorJson,
  ExecutorCapabilityDescriptorSchema,
  ExecutorCommandEnvelopeSchema,
  ExecutorCommandReceiptSchema,
  type ExecutorCommandEnvelope,
  type ExecutorCommandReceipt,
} from '@nessie/schemas'
import { decryptWithKey, deriveSecretKey, encryptWithKey } from '@nessie/runtime'

import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { resolveExecutorAvailability } from './availability.js'
import { ensureExecutorLogicalTools } from './executor-logical-tools.js'
import { resolveExecutorScopeFacts } from './executor-scope-facts.js'

const MAX_RESULT_BYTES = 65_536
const CODING_SESSION_OPERATION_KEYS = new Set([
  'coding.launch',
  'coding.observe',
  'workspace.review',
  'sandbox.stop',
])
const COMMAND_SESSION_OPERATION_KEYS = new Set([
  'command.run',
  'workspace.review',
  'sandbox.stop',
])

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

const booleanRecord = (value: unknown): Record<string, boolean> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
        ),
      )
    : {}

export type ExecutorCommandCreateInput = {
  bindingId: string
  commandId: string
  encryptionSecret: string
  expiresAt: Date
  queueJobId: string
  toolCallId: string
  payload: Record<string, unknown>
}

/** New work is fenced immediately when policy, revision, or lifecycle changes. */
export const assertExecutorCommandBindingCurrent = async (
  tx: Prisma.TransactionClient,
  bindingId: string,
  options: {
    allowPendingBrowserOpen?: boolean
    allowPendingCodingLaunch?: boolean
    allowPendingCommandRun?: boolean
  } = {},
): Promise<{ executorId: string; runId: string; sessionId: string | null }> => {
  let binding = await tx.executorBinding.findUnique({
    where: { id: bindingId },
    select: {
      authorizationRevision: true,
      candidateHandleDigest: true,
      capabilityRevisionId: true,
      executorId: true,
      operationKey: true,
      runId: true,
      sessionId: true,
      session: { select: { executorId: true, profile: true, runId: true, status: true } },
    },
  })
  if (!binding) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor binding is unavailable.')
  }
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${binding.executorId}`}, 0))
  `)
  // The first lookup yields only the executor identity used for the advisory
  // lock. Re-read after that lock so a concurrent sandbox.stop cannot change
  // this browser session between an earlier snapshot and delivery.
  const lockedBinding = await tx.executorBinding.findUnique({
    where: { id: bindingId },
    select: {
      authorizationRevision: true,
      candidateHandleDigest: true,
      capabilityRevisionId: true,
      executorId: true,
      operationKey: true,
      runId: true,
      sessionId: true,
      session: { select: { executorId: true, profile: true, runId: true, status: true } },
    },
  })
  if (!lockedBinding || lockedBinding.executorId !== binding.executorId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding changed while command delivery was being fenced.',
    )
  }
  binding = lockedBinding
  const candidate = await tx.executorAvailabilityCandidate.findUnique({
    where: { handleDigest: binding.candidateHandleDigest },
    select: {
      actorUserId: true,
      agentId: true,
      authorizationRevision: true,
      executorId: true,
      runId: true,
    },
  })
  if (
    !candidate
    || candidate.executorId !== binding.executorId
    || candidate.authorizationRevision !== binding.authorizationRevision
    || (candidate.runId !== null && candidate.runId !== binding.runId)
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding provenance is no longer available.',
    )
  }
  const commandSession = binding.session?.profile === 'workspace_sandbox'
  const sessionMatchesBinding = Boolean(
    binding.sessionId
    && binding.session?.executorId === binding.executorId
    && binding.session?.runId === binding.runId,
  )
  const commandBoundOperation = (
    binding.operationKey === 'command.run'
    || (commandSession && COMMAND_SESSION_OPERATION_KEYS.has(binding.operationKey))
  )
  if (
    commandBoundOperation && binding.operationKey !== 'sandbox.stop'
    && (
      !sessionMatchesBinding
      || !commandSession
      || (
        binding.session?.status !== 'active'
        && !(
          options.allowPendingCommandRun === true
          && binding.operationKey === 'command.run'
          && binding.session?.status === 'pending'
        )
      )
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'The command session is no longer active for this executor command.',
    )
  }
  const executor = await tx.executor.findUnique({
    where: { id: binding.executorId },
    select: {
      authorizationRevision: true,
      id: true,
      organizationId: true,
      projectId: true,
      scopeKind: true,
      status: true,
      capabilityRevisions: { orderBy: { revision: 'desc' }, select: { id: true }, take: 1 },
      operationGrants: {
        where: { agentId: candidate.agentId, operationKey: binding.operationKey },
        select: { state: true },
      },
      privateAssignments: {
        select: { agentId: true, principalKind: true, role: true, userId: true },
      },
    },
  })
  if (!executor) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding is no longer authorized for new work.',
    )
  }
  const [capabilityRevision, run, membership, agent, logicalTools] = await Promise.all([
    tx.executorCapabilityRevision.findUnique({
      where: { id: binding.capabilityRevisionId },
      select: { descriptor: true, reviewStatus: true },
    }),
    tx.run.findUnique({
      where: { id: binding.runId },
      select: {
        agentId: true,
        triggerMessage: { select: { userId: true } },
        thread: { select: { channel: { select: { organizationId: true, projectId: true } } } },
      },
    }),
    tx.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: executor.organizationId,
          userId: candidate.actorUserId,
        },
      },
      select: { deactivatedAt: true },
    }),
    tx.agent.findFirst({
      where: { id: candidate.agentId, organizationId: executor.organizationId },
      select: { toolPolicy: true },
    }),
    ensureExecutorLogicalTools(tx, executor.organizationId),
  ])
  const projectId = run?.thread.channel.projectId ?? null
  const projectMembership = projectId
    ? await tx.projectMember.findFirst({
        where: {
          projectId,
          project: { organizationId: executor.organizationId },
          userId: candidate.actorUserId,
        },
        select: { id: true },
      })
    : null
  const descriptor = capabilityRevision
    ? ExecutorCapabilityDescriptorSchema.safeParse(capabilityRevision.descriptor)
    : null
  const decision = resolveExecutorAvailability({
    descriptorApproved:
      capabilityRevision?.reviewStatus === 'active'
      && executor.capabilityRevisions[0]?.id === binding.capabilityRevisionId
      && descriptor?.success === true,
    executorStatus: executor.status,
    localPolicyAllows: Boolean(
      descriptor?.success && descriptor.data.operationKeys.includes(binding.operationKey as never),
    ),
    logicalToolAllowed: Boolean(
      agent && booleanRecord(agent.toolPolicy)[logicalTools.get(binding.operationKey as never) ?? ''] === true,
    ),
    operationGrantState: executor.operationGrants[0]?.state ?? null,
    scope: resolveExecutorScopeFacts(
      executor,
      candidate.actorUserId,
      candidate.agentId,
      { projectId, projectMember: Boolean(projectMembership) },
    ),
  })
  if (
    executor.authorizationRevision !== binding.authorizationRevision
    || !run
    || run.agentId !== candidate.agentId
    || run.triggerMessage?.userId !== candidate.actorUserId
    || run.thread.channel.organizationId !== executor.organizationId
    || !membership
    || membership.deactivatedAt !== null
    || !decision.available
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding is no longer authorized for new work.',
    )
  }
  if (
    commandSession
    && binding.operationKey === 'command.run'
    && (!sessionMatchesBinding || !COMMAND_SESSION_OPERATION_KEYS.has(binding.operationKey))
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'A command session cannot dispatch an operation outside its exact bundle.',
    )
  }
  if (
    (
      binding.operationKey === 'browser.open'
      || binding.operationKey === 'browser.observe'
      || binding.operationKey === 'browser.act'
    )
    && (
      !sessionMatchesBinding
      || binding.session?.profile !== 'workspace_sandbox'
      || (
        binding.session.status !== 'active'
        && !(
          options.allowPendingBrowserOpen === true
          && binding.operationKey === 'browser.open'
          && binding.session.status === 'pending'
        )
      )
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'The browser session is no longer active for this executor command.',
    )
  }
  const codingSession = binding.session?.profile === 'coding_session'
  const codingBoundOperation = (
    binding.operationKey === 'coding.launch'
    || binding.operationKey === 'coding.observe'
    || (codingSession && CODING_SESSION_OPERATION_KEYS.has(binding.operationKey))
  )
  if (
    codingBoundOperation && binding.operationKey !== 'sandbox.stop'
    && (
      !sessionMatchesBinding
      || !codingSession
      || (
        binding.session?.status !== 'active'
        && binding.session?.status !== 'attention'
        && !(
          options.allowPendingCodingLaunch === true
          && binding.operationKey === 'coding.launch'
          && binding.session?.status === 'pending'
        )
      )
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'The coding session is no longer active for this executor command.',
    )
  }
  if (
    codingSession
    && (!sessionMatchesBinding || !CODING_SESSION_OPERATION_KEYS.has(binding.operationKey))
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'A coding session cannot dispatch an operation outside its exact bundle.',
    )
  }
  return { executorId: executor.id, runId: binding.runId, sessionId: binding.sessionId }
}

/**
 * The worker creates the queue job and ToolCall in its own transaction, then
 * persists this protocol record. Queue JSON contains only `commandId`; raw
 * operation arguments live exclusively in this encrypted column.
 */
export const createExecutorCommand = async (
  prisma: Pick<PrismaClient, 'executorCommand'>,
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
  return prisma.$transaction(async (tx) => {
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
      const current = await assertExecutorCommandBindingCurrent(tx, command.bindingId)
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
      const result = { code: EXECUTOR_ERROR_CODES.BINDING_FENCED, success: false }
      await tx.executorCommand.updateMany({
        where: { id: command.id, state: 'leased' },
        data: {
          acknowledgedAt: now,
          resultCiphertext: encryptJson(encryptionSecret, result),
          resultDigest: digest(result),
          state: 'result_acknowledged',
        },
      })
      return null
    }
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
  || (current === 'unknown_outcome' && next === 'result_acknowledged')
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
              resultCiphertext: encryptJson(encryptionSecret, result),
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
  await markExecutorCommandUnknownOutcome(prisma, commandId)
  return null
}
