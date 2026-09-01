import type { Prisma, PrismaClient } from '@prisma/client'
import {
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

const EXECUTOR_TOOL_SCOPE_KEY = 'executor'

type ExecutorLogicalTool = {
  description: string
  key: ImplementedExecutorOperationKey
  label: string
}

const logicalToolDetails = {
  'file.list': { label: 'List workspace files', description: 'List files within an approved executor workspace.' },
  'file.read': { label: 'Read workspace file', description: 'Read a bounded file from an approved executor workspace.' },
  'file.write': { label: 'Write workspace file', description: 'Write a file only within an approved executor workspace.' },
  'command.run': { label: 'Run workspace command', description: 'Run a bounded shell-free argv command in an isolated copy-on-write workspace.' },
  'browser.open': { label: 'Open sandbox browser', description: 'Open a URL in an isolated executor browser.' },
  'browser.observe': { label: 'Observe sandbox browser', description: 'Observe bounded state from an isolated executor browser.' },
  'browser.act': { label: 'Act in sandbox browser', description: 'Perform a bounded accessibility-node action in an isolated executor browser.' },
  'browser.connected.open': { label: 'Open connected browser', description: 'Open an approved URL in a person-approved browser tab.' },
  'browser.connected.observe': { label: 'Observe connected browser', description: 'Observe bounded accessibility state from a person-approved browser tab.' },
  'browser.connected.act': { label: 'Act in connected browser', description: 'Perform a bounded accessibility-node action in a person-approved browser tab.' },
  'coding.launch': { label: 'Launch coding session', description: 'Launch a dedicated executor coding session.' },
  'coding.observe': { label: 'Observe coding session', description: 'Observe bounded output from a dedicated coding session.' },
  'workspace.review': { label: 'Review sandbox changes', description: 'Produce a bounded, read-only manifest of copy-on-write workspace changes.' },
  'workspace.promote': { label: 'Promote workspace changes', description: 'Promote a reviewed workspace change back to its approved host root.' },
  'sandbox.stop': { label: 'Stop executor sandbox', description: 'Stop an executor sandbox or session.' },
} satisfies Record<ImplementedExecutorOperationKey, Omit<ExecutorLogicalTool, 'key'>>

const logicalTools: readonly ExecutorLogicalTool[] = IMPLEMENTED_EXECUTOR_OPERATION_KEYS.map((key) => ({
  key,
  ...logicalToolDetails[key],
}))

export const executorLogicalToolId = (operationKey: ImplementedExecutorOperationKey): string =>
  `executor.${operationKey}`

export const executorLogicalToolDefinitions = (): readonly ExecutorLogicalTool[] => logicalTools

/**
 * Executor tools are logical operation names, never per-machine projections.
 * The actual machine is chosen later by the availability/binding authority.
 */
export const ensureExecutorLogicalTools = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
): Promise<Map<ImplementedExecutorOperationKey, string>> => {
  await prisma.toolRegistryEntry.deleteMany({
    where: {
      organizationId,
      scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
      source: 'executor',
      toolId: { notIn: logicalTools.map((tool) => executorLogicalToolId(tool.key)) },
    },
  })
  const entries = await Promise.all(logicalTools.map(async (tool) => {
    return prisma.toolRegistryEntry.upsert({
      where: {
        organizationId_scopeKey_toolId: {
          organizationId,
          scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
          toolId: executorLogicalToolId(tool.key),
        },
      },
      create: {
        description: tool.description,
        enabled: true,
        handlerKind: 'executor',
        inputSchema: { type: 'object' } as Prisma.InputJsonValue,
        label: tool.label,
        metadata: {
          executorOperationKey: tool.key,
          requiresExplicitGrant: true,
        } as Prisma.InputJsonValue,
        organizationId,
        overview: tool.description,
        scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
        source: 'executor',
        toolId: executorLogicalToolId(tool.key),
        transport: 'executor',
        transportConfig: { operationKey: tool.key, transport: 'executor' } as Prisma.InputJsonValue,
      },
      update: {
        description: tool.description,
        handlerKind: 'executor',
        inputSchema: { type: 'object' } as Prisma.InputJsonValue,
        label: tool.label,
        metadata: {
          executorOperationKey: tool.key,
          requiresExplicitGrant: true,
        } as Prisma.InputJsonValue,
        overview: tool.description,
        scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
        transport: 'executor',
        transportConfig: { operationKey: tool.key, transport: 'executor' } as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
  }))
  return new Map(entries.map((entry, index) => [logicalTools[index]!.key, entry.id]))
}
