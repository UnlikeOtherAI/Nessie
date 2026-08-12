import type { Prisma, PrismaClient } from '@prisma/client'
import {
  ExecutorOperationKeySchema,
  type ExecutorOperationKey,
} from '@nessie/schemas'

const EXECUTOR_TOOL_SCOPE_KEY = 'executor'

type ExecutorLogicalTool = {
  description: string
  key: ExecutorOperationKey
  label: string
}

const logicalTools: ExecutorLogicalTool[] = [
  { key: 'file.list', label: 'List workspace files', description: 'List files within an approved executor workspace.' },
  { key: 'file.read', label: 'Read workspace file', description: 'Read a bounded file from an approved executor workspace.' },
  { key: 'file.write', label: 'Write workspace file', description: 'Write a file only within an approved executor workspace.' },
  { key: 'command.run', label: 'Run workspace command', description: 'Run a validated argv command in an approved executor workspace.' },
  { key: 'browser.open', label: 'Open sandbox browser', description: 'Open a URL in an isolated executor browser.' },
  { key: 'browser.observe', label: 'Observe sandbox browser', description: 'Observe bounded state from an isolated executor browser.' },
  { key: 'browser.act', label: 'Act in sandbox browser', description: 'Perform an approved action in an isolated executor browser.' },
  { key: 'workspace.promote', label: 'Promote workspace changes', description: 'Promote a reviewed workspace change back to its approved host root.' },
  { key: 'sandbox.stop', label: 'Stop executor sandbox', description: 'Stop an executor sandbox or session.' },
  { key: 'coding.launch', label: 'Launch coding session', description: 'Launch a dedicated executor coding session.' },
  { key: 'coding.attach', label: 'Attach coding session', description: 'Attach to a coding session created by this executor.' },
  { key: 'coding.observe', label: 'Observe coding session', description: 'Observe bounded output from a dedicated coding session.' },
  { key: 'coding.prompt', label: 'Prompt coding session', description: 'Send approved input to a dedicated coding session.' },
  { key: 'coding.interrupt', label: 'Interrupt coding session', description: 'Interrupt a dedicated coding session.' },
  { key: 'coding.close', label: 'Close coding session', description: 'Close a dedicated coding session.' },
]

export const executorLogicalToolId = (operationKey: ExecutorOperationKey): string =>
  `executor.${operationKey}`

export const executorLogicalToolDefinitions = (): readonly ExecutorLogicalTool[] => logicalTools

/**
 * Executor tools are logical operation names, never per-machine projections.
 * The actual machine is chosen later by the availability/binding authority.
 */
export const ensureExecutorLogicalTools = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
): Promise<Map<ExecutorOperationKey, string>> => {
  const entries = await Promise.all(logicalTools.map(async (tool) => {
    const operationKey = ExecutorOperationKeySchema.parse(tool.key)
    return prisma.toolRegistryEntry.upsert({
      where: {
        organizationId_scopeKey_toolId: {
          organizationId,
          scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
          toolId: executorLogicalToolId(operationKey),
        },
      },
      create: {
        description: tool.description,
        enabled: true,
        handlerKind: 'executor',
        inputSchema: { type: 'object' } as Prisma.InputJsonValue,
        label: tool.label,
        metadata: {
          executorOperationKey: operationKey,
          requiresExplicitGrant: true,
        } as Prisma.InputJsonValue,
        organizationId,
        overview: tool.description,
        scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
        source: 'executor',
        toolId: executorLogicalToolId(operationKey),
        transport: 'executor',
        transportConfig: { operationKey, transport: 'executor' } as Prisma.InputJsonValue,
      },
      update: {
        description: tool.description,
        handlerKind: 'executor',
        inputSchema: { type: 'object' } as Prisma.InputJsonValue,
        label: tool.label,
        metadata: {
          executorOperationKey: operationKey,
          requiresExplicitGrant: true,
        } as Prisma.InputJsonValue,
        overview: tool.description,
        scopeKey: EXECUTOR_TOOL_SCOPE_KEY,
        transport: 'executor',
        transportConfig: { operationKey, transport: 'executor' } as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
  }))
  return new Map(entries.map((entry, index) => [logicalTools[index]!.key, entry.id]))
}
