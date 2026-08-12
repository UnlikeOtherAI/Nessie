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

type ExecutorEntry = {
  bindingId: string
  operationKey: string
  toolName: string
}

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
  return {
    description: definition.description,
    inputSchema: operationKey === 'sandbox.stop'
      ? { additionalProperties: false, properties: {}, type: 'object' }
      : { type: 'object' },
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
      select: { id: true, operationKey: true },
    }),
  ])
  const entries = bindings.flatMap((binding): ExecutorEntry[] => {
    const registryId = logicalTools.get(binding.operationKey as never)
    const descriptor = descriptorFor(binding.operationKey)
    if (!registryId || input.agentToolPolicy?.[registryId] !== true || !descriptor) return []
    return [{ bindingId: binding.id, operationKey: binding.operationKey, toolName: descriptor.toolName }]
  })
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
        const binding = await assertExecutorCommandBindingCurrent(tx, entry.bindingId)
        if (binding.runId !== input.runId) throw new Error('Executor binding run mismatch.')
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
        const expiresAt = new Date(startedAt.getTime() + COMMAND_TTL_MS)
        await createExecutorCommand(tx, {
          bindingId: entry.bindingId,
          commandId,
          encryptionSecret,
          expiresAt,
          payload: { args },
          queueJobId: queueJob.id,
          toolCallId: toolCall.id,
        })
        return { expiresAt, toolCallId: toolCall.id }
      })
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
