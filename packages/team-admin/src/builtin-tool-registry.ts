import type { Prisma, PrismaClient } from '@prisma/client'
import { SYSTEM_TOOL_DEFINITIONS, type BuiltinToolDefinition } from '@nessie/runtime'

type RegistryClient = PrismaClient | Prisma.TransactionClient

/** Register one builtin in an organisation's tool registry, keeping its words in step with the code. */
const upsertBuiltinTool = (prisma: RegistryClient, organizationId: string, tool: BuiltinToolDefinition) =>
  prisma.toolRegistryEntry.upsert({
    where: {
      organizationId_scopeKey_toolId: {
        organizationId,
        scopeKey: 'builtin',
        toolId: tool.id,
      },
    },
    create: {
      builtin: true,
      description: tool.description,
      enabled: true,
      handlerKind: 'builtin',
      label: tool.label,
      organizationId,
      overview: tool.description,
      safe: tool.safe,
      scopeKey: 'builtin',
      toolId: tool.id,
    },
    update: {
      builtin: true,
      description: tool.description,
      handlerKind: 'builtin',
      label: tool.label,
      safe: tool.safe,
      scopeKey: 'builtin',
    },
  })

/**
 * Register every builtin (two hundred and more upserts). For the tool
 * surfaces that list them all — never inside a short interactive
 * transaction, where each upsert is one more round trip on its one connection
 * and the whole set can outrun Prisma's transaction timeout under load.
 */
export const ensureBuiltinToolsRegistered = async (
  prisma: RegistryClient,
  organizationId: string,
): Promise<void> => {
  await Promise.all(SYSTEM_TOOL_DEFINITIONS.map((tool) => upsertBuiltinTool(prisma, organizationId, tool)))
}

/**
 * Register the one builtin a caller reads, and nothing else: safe inside a
 * lock-holding transaction. Throws for an id that is not a builtin, which is a
 * caller bug rather than a row to invent.
 */
export const ensureBuiltinToolRegistered = async (
  prisma: RegistryClient,
  organizationId: string,
  toolId: string,
): Promise<void> => {
  const tool = SYSTEM_TOOL_DEFINITIONS.find((definition) => definition.id === toolId)
  if (!tool) throw new Error(`${toolId} is not a builtin tool`)
  await upsertBuiltinTool(prisma, organizationId, tool)
}
