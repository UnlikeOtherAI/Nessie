import { randomUUID } from 'node:crypto'

import {
  assertExecutorCommandBindingCurrent,
  createExecutorCommand,
  ensureExecutorLogicalTools,
  executorLogicalToolDefinitions,
  waitForExecutorCommandResult,
} from '@nessie/executor-manage'
import type { PrismaClient } from '@prisma/client'
import type { ToolSchemaDescriptor } from '@nessie/runtime'

import { FatalToolExecutionError } from './tool-execution-errors.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

const EXECUTOR_COMMAND_TOPIC = 'executor.command'
const COMMAND_TTL_MS = 25_000
// Guest startup includes a bounded initrd build and VM handshake before the
// browser request itself; the ordinary file-operation timeout is too short.
const BROWSER_COMMAND_TTL_MS = 3 * 60 * 1_000

type ExecutorEntry = {
  bindingId: string
  operationKey: string
  sessionId: string | null
  sessionProfile: 'coding_session' | 'workspace_sandbox' | null
  toolName: string
}

const compareToolName = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export type ExecutorToolset = {
  descriptors: ToolSchemaDescriptor[]
  dispatch: (toolName: string, args: Record<string, unknown>, providerToolCallId: string) => Promise<AgenticToolResult>
  handledNames: Set<string>
}

class ExecutorUnknownOutcomeError extends FatalToolExecutionError {
  constructor(readonly toolCallRecordId: string) {
    super('Executor command outcome is unknown.')
  }
}

const descriptorFor = (operationKey: string): ToolSchemaDescriptor | null => {
  const definition = executorLogicalToolDefinitions().find((tool) => tool.key === operationKey)
  if (!definition) return null
  const inputSchema = (() => {
    switch (operationKey) {
      case 'file.list':
        return {
          additionalProperties: false,
          properties: {
            maxEntries: { maximum: 100, minimum: 1, type: 'integer' },
            path: { maxLength: 1_024, type: 'string' },
          },
          type: 'object',
        }
      case 'file.read':
        return {
          additionalProperties: false,
          properties: {
            maxBytes: { maximum: 8_192, minimum: 1, type: 'integer' },
            path: { maxLength: 1_024, minLength: 1, type: 'string' },
          },
          required: ['path'],
          type: 'object',
        }
      case 'file.write':
        return {
          additionalProperties: false,
          properties: {
            content: { maxLength: 65_536, type: 'string' },
            createParents: { type: 'boolean' },
            overwrite: { type: 'boolean' },
            path: { maxLength: 1_024, minLength: 1, type: 'string' },
          },
          required: ['content', 'path'],
          type: 'object',
        }
      case 'browser.open':
        return {
          additionalProperties: false,
          properties: { url: { format: 'uri', maxLength: 4_096, type: 'string' } },
          required: ['url'],
          type: 'object',
        }
      case 'browser.observe':
        return { additionalProperties: false, properties: {}, type: 'object' }
      case 'coding.launch':
        return {
          additionalProperties: false,
          properties: { prompt: { maxLength: 4_096, minLength: 1, type: 'string' } },
          required: ['prompt'],
          type: 'object',
        }
      case 'coding.observe':
        return { additionalProperties: false, properties: {}, type: 'object' }
      case 'workspace.review':
        return { additionalProperties: false, properties: {}, type: 'object' }
      case 'sandbox.stop':
        return { additionalProperties: false, properties: {}, type: 'object' }
      default:
        // A descriptor alone cannot enable an operation. Add its hardened
        // companion backend and exact model schema before it is reachable.
        return null
    }
  })()
  if (!inputSchema) return null
  return {
    description: definition.description,
    inputSchema,
    toolName: `executor.${operationKey}`,
  }
}

export const buildExecutorToolset = async (
  prisma: PrismaClient,
  input: {
    agentToolPolicy: Record<string, boolean> | null
    agentId: string
    encryptionSecret: string | undefined
    organizationId: string
    runId: string
  },
): Promise<ExecutorToolset> => {
  const encryptionSecret = input.encryptionSecret
  if (!encryptionSecret) {
    return { descriptors: [], dispatch: async () => ({ inputSummary: '', output: 'Executor transport is unavailable.', success: false }), handledNames: new Set() }
  }
  const [logicalTools, bindings] = await Promise.all([
    ensureExecutorLogicalTools(prisma, input.organizationId),
    prisma.executorBinding.findMany({
      where: { runId: input.runId },
      select: {
        id: true,
        operationKey: true,
        session: { select: { id: true, profile: true, status: true } },
      },
    }),
  ])
  const codingOperationKeys = new Set(['coding.launch', 'coding.observe', 'workspace.review', 'sandbox.stop'])
  const browserBindings = bindings.filter((binding) => (
    binding.operationKey === 'browser.open'
    || binding.operationKey === 'browser.observe'
    || (
      binding.operationKey === 'sandbox.stop'
      && binding.session?.profile === 'workspace_sandbox'
    )
  ))
  const browserSessionId = browserBindings[0]?.session?.id
  const browserSessionLive = browserBindings.every((binding) => (
    binding.session?.status === 'pending' || binding.session?.status === 'active'
  ))
  const hasExactBrowserBundle = Boolean(
    browserSessionId
    && bindings.length === 3
    && browserBindings.length === 3
    && browserBindings.every((binding) => binding.session?.id === browserSessionId)
    && browserBindings.some((binding) => binding.operationKey === 'browser.open')
    && browserBindings.some((binding) => binding.operationKey === 'browser.observe')
    && browserBindings.some((binding) => binding.operationKey === 'sandbox.stop')
    && browserSessionLive,
  )
  const codingBindings = bindings.filter((binding) => binding.session?.profile === 'coding_session')
  const codingSessionId = codingBindings[0]?.session?.id
  const codingSessionLive = codingBindings.every((binding) => (
    binding.session?.status === 'pending'
    || binding.session?.status === 'active'
    || binding.session?.status === 'attention'
  ))
  const hasExactCodingBundle = Boolean(
    codingSessionId
    && bindings.length === 4
    && codingBindings.length === 4
    && codingBindings.every((binding) => binding.session?.id === codingSessionId)
    && [...codingOperationKeys].every((operationKey) => (
      codingBindings.some((binding) => binding.operationKey === operationKey)
    ))
    && codingSessionLive,
  )
  const entries = bindings.flatMap((binding): ExecutorEntry[] => {
    const browserSessionBinding = binding.operationKey === 'browser.open'
      || binding.operationKey === 'browser.observe'
      || (
        binding.operationKey === 'sandbox.stop'
        && binding.session?.profile === 'workspace_sandbox'
      )
    const codingSessionBinding = binding.session?.profile === 'coding_session'
    if (browserSessionBinding && !hasExactBrowserBundle) {
      return []
    }
    if (codingSessionBinding && !hasExactCodingBundle) return []
    if (binding.session?.profile === 'coding_session'
      && binding.session.status === 'attention'
      && binding.operationKey === 'coding.launch') return []
    const registryId = logicalTools.get(binding.operationKey as never)
    const descriptor = descriptorFor(binding.operationKey)
    if (!registryId || input.agentToolPolicy?.[registryId] !== true || !descriptor) return []
    return [{
      bindingId: binding.id,
      operationKey: binding.operationKey,
      sessionId: binding.session?.id ?? null,
      sessionProfile: binding.session?.profile ?? null,
      toolName: descriptor.toolName,
    }]
  }).sort((left, right) => compareToolName(left.toolName, right.toolName))
  const entryByName = new Map(entries.map((entry) => [entry.toolName, entry]))

  return {
    descriptors: entries.flatMap((entry) => {
      const descriptor = descriptorFor(entry.operationKey)
      return descriptor ? [descriptor] : []
    }),
    dispatch: async (toolName, args, providerToolCallId) => {
      const entry = entryByName.get(toolName)
      if (!entry) {
        return { inputSummary: summarizeToolInput(args), output: `Unknown executor tool: ${toolName}`, success: false }
      }
      const startedAt = new Date()
      const commandId = randomUUID()
      const created = await prisma.$transaction(async (tx) => {
        const binding = await assertExecutorCommandBindingCurrent(tx, entry.bindingId, {
          // browser.open is the one transition that consumes its freshly
          // created pending session. Delivery still requires active, so a
          // queued command cannot reopen a stopped browser.
          allowPendingBrowserOpen: entry.operationKey === 'browser.open',
          allowPendingCodingLaunch: entry.operationKey === 'coding.launch',
        })
        if (binding.runId !== input.runId) throw new Error('Executor binding run mismatch.')
        if (binding.sessionId !== entry.sessionId) throw new Error('Executor binding session mismatch.')
        if (entry.operationKey === 'browser.open' || entry.operationKey === 'coding.launch') {
          if (!binding.sessionId || !entry.sessionProfile) {
            return { sessionUnavailable: entry.sessionProfile ?? 'workspace_sandbox' as const }
          }
          const activated = await tx.executorSession.updateMany({
            where: {
              executorId: binding.executorId,
              id: binding.sessionId,
              profile: entry.sessionProfile,
              runId: input.runId,
              status: 'pending',
            },
            data: { status: 'active' },
          })
          if (activated.count !== 1) return { sessionUnavailable: entry.sessionProfile }
        }
        if (
          entry.operationKey === 'browser.observe'
          || (entry.sessionProfile === 'coding_session' && (
            entry.operationKey === 'coding.observe' || entry.operationKey === 'workspace.review'
          ))
        ) {
          if (!binding.sessionId || !entry.sessionProfile) {
            return { sessionUnavailable: entry.sessionProfile ?? 'workspace_sandbox' as const }
          }
          const active = await tx.executorSession.findFirst({
            where: {
              executorId: binding.executorId,
              id: binding.sessionId,
              profile: entry.sessionProfile,
              runId: input.runId,
              status: entry.sessionProfile === 'coding_session'
                ? { in: ['active', 'attention'] }
                : 'active',
            },
            select: { id: true },
          })
          if (!active) return { sessionUnavailable: entry.sessionProfile }
        }
        if (entry.operationKey === 'sandbox.stop' && binding.sessionId) {
          await tx.executorSession.updateMany({
            where: {
              executorId: binding.executorId,
              id: binding.sessionId,
              ...(entry.sessionProfile ? { profile: entry.sessionProfile } : {}),
              runId: input.runId,
              status: { in: ['pending', 'active', 'attention', 'detached'] },
            },
            data: { status: 'stopped' },
          })
        }
        const toolCall = await tx.toolCall.create({
          data: {
            agentId: input.agentId,
            inputSummary: summarizeToolInput(args),
            runId: input.runId,
            startedAt,
            toolName,
            executorBindingId: entry.bindingId,
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
        const expiresAt = new Date(startedAt.getTime() + (
          entry.operationKey === 'browser.open'
          || entry.operationKey === 'browser.observe'
          || entry.operationKey === 'coding.launch'
            ? BROWSER_COMMAND_TTL_MS
            : COMMAND_TTL_MS
        ))
        await createExecutorCommand(tx, {
          bindingId: entry.bindingId,
          commandId,
          encryptionSecret,
          expiresAt,
          payload: { args, runId: input.runId },
          queueJobId: queueJob.id,
          toolCallId: toolCall.id,
        })
        return { expiresAt, toolCallId: toolCall.id }
      })
      if ('sessionUnavailable' in created) {
        return {
          inputSummary: summarizeToolInput(args),
          output: created.sessionUnavailable === 'coding_session'
            ? 'The coding session is no longer available for this run.'
            : 'The browser session is no longer available for this run.',
          success: false,
        }
      }
      const result = await waitForExecutorCommandResult(
        prisma,
        encryptionSecret,
        commandId,
        created.expiresAt,
      )
      if (!result) throw new ExecutorUnknownOutcomeError(created.toolCallId)
      return {
        inputSummary: summarizeToolInput(args),
        output: JSON.stringify(result),
        success: result.success === true,
        toolCallRecordId: created.toolCallId,
      }
    },
    handledNames: new Set(entries.map((entry) => entry.toolName)),
  }
}

export { EXECUTOR_COMMAND_TOPIC }
