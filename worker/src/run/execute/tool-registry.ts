import type { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS, BUILTIN_TOOL_IDS } from '@nessie/runtime'
import type { RunContext } from './types.js'

const BUILTIN_TOOL_SCOPE_KEY = 'builtin'

// Builtin registry entries only change on deploy, so seeding them on every run
// is N pointless writes. Seed each organisation at most once per worker process
// (lazily on its first run) and read enabled entries on every run thereafter.
const seededBuiltinOrganizations = new Set<string>()

const seedBuiltinToolRegistry = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> => {
  if (seededBuiltinOrganizations.has(organizationId)) {
    return
  }

  await Promise.all(
    BUILTIN_TOOL_DEFINITIONS.map((tool) =>
      prisma.toolRegistryEntry.upsert({
        where: {
          organizationId_scopeKey_toolId: {
            organizationId,
            scopeKey: BUILTIN_TOOL_SCOPE_KEY,
            toolId: tool.id,
          },
        },
        create: {
          builtin: true,
          description: tool.description,
          // Builtins ship with short one-line descriptions that double as the
          // human-readable summary required by spec §3.1.
          overview: tool.description,
          enabled: true,
          handlerKind: 'builtin',
          label: tool.label,
          organizationId,
          scopeKey: BUILTIN_TOOL_SCOPE_KEY,
          safe: tool.safe,
          toolId: tool.id,
        },
        update: {
          builtin: true,
          description: tool.description,
          handlerKind: 'builtin',
          label: tool.label,
          scopeKey: BUILTIN_TOOL_SCOPE_KEY,
          safe: tool.safe,
        },
      }),
    ),
  )

  seededBuiltinOrganizations.add(organizationId)
}

export const loadAllowedToolIds = async (
  prisma: PrismaClient,
  context: RunContext,
): Promise<Set<string>> => {
  await seedBuiltinToolRegistry(prisma, context.channel.organizationId)

  const enabledRegistryEntries = await prisma.toolRegistryEntry.findMany({
    where: {
      builtin: true,
      enabled: true,
      organizationId: context.channel.organizationId,
    },
    select: { toolId: true },
  })

  const enabledToolIds = new Set(
    enabledRegistryEntries
      .map((entry) => entry.toolId)
      .filter((toolId) => BUILTIN_TOOL_IDS.has(toolId)),
  )

  const [runScopedSessions, threadScopedSessions, agentScopedSessions] = await Promise.all([
    prisma.temporaryContextSession.findMany({
      where: {
        organizationId: context.channel.organizationId,
        droppedAt: null,
        runId: context.run.id,
      },
      select: { toolIds: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.temporaryContextSession.findMany({
      where: {
        organizationId: context.channel.organizationId,
        droppedAt: null,
        threadId: context.run.threadId,
      },
      select: { toolIds: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.temporaryContextSession.findMany({
      where: {
        organizationId: context.channel.organizationId,
        droppedAt: null,
        agentId: context.agent.id,
      },
      select: { toolIds: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
  ])

  const activeSessions =
    runScopedSessions.length > 0
      ? runScopedSessions
      : threadScopedSessions.length > 0
        ? threadScopedSessions
        : agentScopedSessions

  const sessionToolIds = new Set<string>()
  for (const session of activeSessions) {
    if (!Array.isArray(session.toolIds)) {
      continue
    }
    for (const value of session.toolIds) {
      if (typeof value === 'string') {
        sessionToolIds.add(value)
      }
    }
  }

  if (sessionToolIds.size === 0) {
    return enabledToolIds
  }

  return new Set([...enabledToolIds].filter((toolId) => sessionToolIds.has(toolId)))
}
