import type { Prisma, PrismaClient } from '@prisma/client'
import { SYSTEM_TOOL_DEFINITIONS } from '@nessie/runtime'

export const ensureBuiltinToolsRegistered = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
): Promise<void> => {
  await Promise.all(
    SYSTEM_TOOL_DEFINITIONS.map((tool) =>
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
      }),
    ),
  )
}
