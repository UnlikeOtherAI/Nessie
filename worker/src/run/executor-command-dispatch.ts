import { randomUUID } from 'node:crypto'

import {
  assertExecutorCommandBindingCurrent,
  createExecutorCommand,
  EXECUTOR_ERROR_CODES,
  ExecutorError,
  waitForExecutorCommandResult,
  type ExecutorCommandBindingFacts,
} from '@nessie/executor-manage'
import type { ExecutorProfile } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { executorCommandTtlMs } from './executor-command-timing.js'
import { isCorrectableExecutorFailure } from './executor-correctable-failures.js'
import { HOST_OUTPUT_OPERATION_KEYS } from './executor-host-output.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

/**
 * One executor command, from the binding check to its result: the ToolCall
 * row, the queue job, the encrypted command with its expiry, and the wait for
 * the daemon's answer. Every executor tool the model holds — the operations,
 * the local-apps pair, the coding-session tools on top of `mcp.call` — goes
 * through here.
 */

export const EXECUTOR_COMMAND_TOPIC = 'executor.command'

/** What a command is sent through: one of the run's bindings. */
export type ExecutorCommandTarget = {
  bindingId: string
  /** The reviewed coding-sessions bridge's server name, when the bound revision offers it. */
  codingSessionsServer: string | null
  operationKey: string
  sessionId: string | null
  sessionProfile: ExecutorProfile | null
}

/** What one executor command came to: its result, or its expiry with nobody seeing it finish. */
export type ExecutorCommandOutcome =
  | { kind: 'result'; result: AgenticToolResult }
  /** `capped`: the expiry was the caller's own deadline, shorter than the command's TTL. */
  | { capped: boolean; kind: 'expired'; toolCallRecordId: string }

/**
 * What dispatch answers for a terminal result: the raw document, verbatim.
 * Task Set search parses exactly this; the model sees it only after the agent
 * loop's presentation (`executor-result-presentation.ts`).
 */
export const executorDispatchResult = (document: Record<string, unknown>) => ({
  output: JSON.stringify(document),
  success: document.success === true,
  ...(isCorrectableExecutorFailure(document) ? { correctable: true as const } : {}),
})

/**
 * The command payload. A call to the bound revision's coding-sessions bridge
 * carries `owner` — the agent and the person the binding's candidate was made
 * for, and the work context when the binding pins one, never anything the
 * model sent — beside `runId`, under the argument digest, and no other call
 * ever does. The model reaches only `args`: an
 * `owner` it puts there is refused by the daemon's strict envelope, and
 * `_meta` inside `arguments` goes to the program as the program's own.
 */
const executorCommandPayload = (
  target: ExecutorCommandTarget,
  args: Record<string, unknown>,
  runId: string,
  binding: ExecutorCommandBindingFacts,
): Record<string, unknown> => {
  const bridgeCall = target.operationKey === 'mcp.call'
    && target.codingSessionsServer !== null
    && args.server === target.codingSessionsServer
  return { args, ...(bridgeCall ? { owner: binding.owner } : {}), runId }
}

export type ExecutorCommandDispatchOptions = {
  /** A deadline the command must expire by, when the caller's is shorter than its TTL. */
  expiresBy?: Date
  /**
   * The ToolCall this command is one step of — a wait's later reads name the
   * wait's own row — so the run's tool-call views show that call once.
   */
  parentToolCallId?: string
}

export type ExecutorCommandDispatch = (
  target: ExecutorCommandTarget,
  toolName: string,
  args: Record<string, unknown>,
  providerToolCallId: string,
  options?: ExecutorCommandDispatchOptions,
) => Promise<ExecutorCommandOutcome>

export const createExecutorCommandDispatch = (input: {
  agentId: string
  encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput
  prisma: PrismaClient
  /** Stamps the run's disclosure basis with the launch conversation. */
  recordHostOutput: () => void
  /**
   * The ToolCall each provider call's command is recorded under, set before
   * the command exists, so a backstop that gives up on a dispatch still names
   * the row it opened.
   */
  recordIdByProviderCall: Map<string, string>
  runId: string
}): ExecutorCommandDispatch => async (target, toolName, args, providerToolCallId, options = {}) => {
  const { encryptionSecret, prisma } = input
  // Before the command exists: whatever the program answers, a failure
  // included, is its output, and a catalog page is as much a read as a call.
  if (HOST_OUTPUT_OPERATION_KEYS.has(target.operationKey)) input.recordHostOutput()
  const startedAt = new Date()
  const commandId = randomUUID()
  const toolCallRecordId = randomUUID()
  input.recordIdByProviderCall.set(providerToolCallId, toolCallRecordId)
  const created = await prisma.$transaction(async (tx) => {
    const binding = await assertExecutorCommandBindingCurrent(tx, target.bindingId, {
      // browser.open is the one transition that consumes its freshly
      // created pending session. Delivery still requires active, so a
      // queued command cannot reopen a stopped browser.
      allowPendingBrowserOpen: target.operationKey === 'browser.open',
      allowPendingCodingLaunch: target.operationKey === 'coding.launch',
      allowPendingCommandRun: target.operationKey === 'command.run',
    })
    if (binding.runId !== input.runId) throw new Error('Executor binding run mismatch.')
    if (binding.sessionId !== target.sessionId) throw new Error('Executor binding session mismatch.')
    if (
      target.operationKey === 'browser.open'
      || target.operationKey === 'coding.launch'
      || target.operationKey === 'command.run'
    ) {
      if (!binding.sessionId || !target.sessionProfile) {
        return { sessionUnavailable: target.sessionProfile ?? 'workspace_sandbox' as const }
      }
      const activated = await tx.executorSession.updateMany({
        where: {
          executorId: binding.executorId,
          id: binding.sessionId,
          profile: target.sessionProfile,
          runId: input.runId,
          status: 'pending',
        },
        data: { status: 'active' },
      })
      if (activated.count !== 1) return { sessionUnavailable: target.sessionProfile }
    }
    if (
      target.operationKey === 'browser.observe'
      || target.operationKey === 'browser.act'
      || (target.sessionProfile === 'workspace_sandbox' && target.operationKey === 'workspace.review')
      || (target.sessionProfile === 'coding_session' && (
        target.operationKey === 'coding.observe' || target.operationKey === 'workspace.review'
      ))
    ) {
      if (!binding.sessionId || !target.sessionProfile) {
        return { sessionUnavailable: target.sessionProfile ?? 'workspace_sandbox' as const }
      }
      const active = await tx.executorSession.findFirst({
        where: {
          executorId: binding.executorId,
          id: binding.sessionId,
          profile: target.sessionProfile,
          runId: input.runId,
          status: target.sessionProfile === 'coding_session'
            ? { in: ['active', 'attention'] }
            : 'active',
        },
        select: { id: true },
      })
      if (!active) return { sessionUnavailable: target.sessionProfile }
    }
    if (target.operationKey === 'sandbox.stop' && binding.sessionId) {
      await tx.executorSession.updateMany({
        where: {
          executorId: binding.executorId,
          id: binding.sessionId,
          ...(target.sessionProfile ? { profile: target.sessionProfile } : {}),
          runId: input.runId,
          status: { in: ['pending', 'active', 'attention', 'detached'] },
        },
        data: { status: 'stopped' },
      })
    }
    const toolCall = await tx.toolCall.create({
      data: {
        id: toolCallRecordId,
        agentId: input.agentId,
        inputSummary: summarizeToolInput(args),
        runId: input.runId,
        startedAt,
        toolName,
        executorBindingId: target.bindingId,
        ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
      },
      select: { id: true },
    })
    const queueJob = await tx.queueJob.create({
      data: {
        idempotencyKey: `executor-command:${input.runId}:${providerToolCallId}`,
        payload: { commandId },
        status: 'pending',
        topic: EXECUTOR_COMMAND_TOPIC,
      },
      select: { id: true },
    })
    const ttlExpiry = new Date(startedAt.getTime() + executorCommandTtlMs(target.operationKey))
    const capped = options.expiresBy !== undefined && options.expiresBy < ttlExpiry
    const expiresAt = capped ? options.expiresBy! : ttlExpiry
    await createExecutorCommand(tx, {
      bindingId: target.bindingId,
      commandId,
      encryptionSecret,
      expiresAt,
      payload: executorCommandPayload(target, args, input.runId, binding),
      queueJobId: queueJob.id,
      toolCallId: toolCall.id,
    })
    return { capped, expiresAt, toolCallId: toolCall.id }
  }).catch((error: unknown) => {
    // The coding-sessions rule refused the call where its command is made:
    // the lane's own refusal, in words the model can pass on to the person.
    if (error instanceof ExecutorError && error.code === EXECUTOR_ERROR_CODES.CODING_SESSIONS_OWNER_ONLY) {
      return { refused: { code: error.code, message: error.message, success: false } }
    }
    throw error
  })
  if ('refused' in created) {
    return { kind: 'result', result: { inputSummary: summarizeToolInput(args), ...executorDispatchResult(created.refused) } }
  }
  if ('sessionUnavailable' in created) {
    return {
      kind: 'result',
      result: {
        inputSummary: summarizeToolInput(args),
        output: created.sessionUnavailable === 'coding_session'
          ? 'The coding session is no longer available for this run.'
          : 'The browser session is no longer available for this run.',
        success: false,
      },
    }
  }
  const result = await waitForExecutorCommandResult(prisma, encryptionSecret, commandId, created.expiresAt)
  if (!result) return { capped: created.capped, kind: 'expired', toolCallRecordId: created.toolCallId }
  return {
    kind: 'result',
    result: {
      inputSummary: summarizeToolInput(args), ...executorDispatchResult(result), toolCallRecordId: created.toolCallId,
    },
  }
}
