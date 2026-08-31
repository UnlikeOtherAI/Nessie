import { Prisma, type PrismaClient } from '@prisma/client'
import { parseOrganizationId } from '@nessie/schemas'
import { SYSTEM_TOOL_DEFINITIONS } from '@nessie/runtime'
import { ensureExecutorLogicalTools } from '@nessie/executor-manage'

// Builtin ids whose exposure requires an explicit per-agent grant (default off).
// The admin tool catalog reads this to render them off-by-default and to write
// an explicit allow when the operator enables them — mirroring the worker.
const EXPLICIT_GRANT_TOOL_IDS = new Set(
  SYSTEM_TOOL_DEFINITIONS.filter((tool) => tool.requiresExplicitGrant).map((tool) => tool.id),
)
import type {
  ToolDescriptor,
  ToolRegistryEntry,
} from '../contracts.js'
import {
  toInputJsonObject,
  toJsonRecord,
} from './contract-helpers.js'

const BUILTIN_TOOL_SCOPE_KEY = 'builtin'

const toToolRegistryScopeKey = (
  organizationId: string,
  builtin: boolean,
): string => (builtin ? BUILTIN_TOOL_SCOPE_KEY : organizationId)

const mapToolRegistryEntry = (entry: {
  builtin: boolean
  createdAt: Date
  description: string
  enabled: boolean
  handlerKind: string
  id: string
  label: string
  metadata: unknown
  organizationId: string | null
  safe: boolean
  toolId: string
  updatedAt: Date
}): ToolRegistryEntry => ({
  id: entry.id,
  organizationId: entry.organizationId ? parseOrganizationId(entry.organizationId) : undefined,
  toolId: entry.toolId,
  label: entry.label,
  description: entry.description,
  safe: entry.safe,
  builtin: entry.builtin,
  enabled: entry.enabled,
  handlerKind: entry.handlerKind,
  metadata: toJsonRecord(entry.metadata),
  createdAt: entry.createdAt.toISOString(),
  updatedAt: entry.updatedAt.toISOString(),
})

const toToolDescriptor = (entry: ToolRegistryEntry): ToolDescriptor => ({
  id: entry.toolId,
  label: entry.label,
  description: entry.description,
  safe: entry.safe,
  builtin: entry.builtin,
  enabled: entry.enabled,
  handlerKind: entry.handlerKind,
  requiresExplicitGrant: EXPLICIT_GRANT_TOOL_IDS.has(entry.toolId) || undefined,
})

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
            scopeKey: BUILTIN_TOOL_SCOPE_KEY,
            toolId: tool.id,
          },
        },
        create: {
          builtin: true,
          description: tool.description,
          // Builtins ship with concise one-line descriptions that already
          // double as the human-readable summary (spec §3.1).
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
}

export const listToolRegistryEntries = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<ToolRegistryEntry[]> => {
  await Promise.all([
    ensureBuiltinToolsRegistered(prisma, organizationId),
    ensureExecutorLogicalTools(prisma, organizationId),
  ])

  const entries = await prisma.toolRegistryEntry.findMany({
    where: {
      organizationId,
    },
    orderBy: [{ builtin: 'desc' }, { label: 'asc' }],
  })

  return entries.map(mapToolRegistryEntry)
}

export const listAvailableTools = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<ToolDescriptor[]> => {
  const entries = await listToolRegistryEntries(prisma, organizationId)
  return entries.filter((entry) => entry.enabled).map(toToolDescriptor)
}

export const registerToolRegistryEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    builtin?: boolean
    description: string
    enabled?: boolean
    handlerKind?: string
    label: string
    metadata?: Record<string, unknown>
    safe?: boolean
    toolId: string
  },
): Promise<ToolRegistryEntry> => {
  const builtin = input.builtin ?? false
  const scopeKey = toToolRegistryScopeKey(organizationId, builtin)

  if (!builtin) {
    const builtinEntry = await prisma.toolRegistryEntry.findUnique({
      where: {
        organizationId_scopeKey_toolId: {
          organizationId,
          scopeKey: BUILTIN_TOOL_SCOPE_KEY,
          toolId: input.toolId,
        },
      },
      select: { id: true },
    })
    if (builtinEntry) {
      throw new Error('BUILTIN_TOOL_ID_RESERVED')
    }
  }

  const entry = await prisma.toolRegistryEntry.upsert({
    where: {
      organizationId_scopeKey_toolId: {
        organizationId,
        scopeKey,
        toolId: input.toolId,
      },
    },
    create: {
      organizationId,
      scopeKey,
      toolId: input.toolId,
      label: input.label,
      description: input.description,
      // Spec §3.1 mandates a non-empty `overview`. The public
      // `registerToolRegistryEntry` API doesn't take one yet (callers only
      // know `description`), so mirror the description — it's a short caller-
      // supplied string and always non-empty by the surrounding contract.
      overview: input.description,
      safe: input.safe ?? false,
      builtin,
      enabled: input.enabled ?? true,
      handlerKind: input.handlerKind ?? 'builtin',
      metadata: (toInputJsonObject(input.metadata) ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      organizationId,
      label: input.label,
      description: input.description,
      safe: input.safe ?? false,
      builtin,
      enabled: input.enabled ?? true,
      handlerKind: input.handlerKind ?? 'builtin',
      metadata: (toInputJsonObject(input.metadata) ?? {}) as Prisma.InputJsonValue,
    },
  })

  return mapToolRegistryEntry(entry)
}
