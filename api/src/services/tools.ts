import { Prisma, type PrismaClient } from '@prisma/client'
import { parseOrganizationId } from '@nessie/schemas'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import type {
  ToolDescriptor,
  ToolRegistryEntry,
} from '../contracts.js'
import {
  toInputJsonObject,
  toJsonRecord,
} from './contract-helpers.js'

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
})

export const ensureBuiltinToolsRegistered = async (
  prisma: PrismaClient,
): Promise<void> => {
  await Promise.all(
    BUILTIN_TOOL_DEFINITIONS.map((tool) =>
      prisma.toolRegistryEntry.upsert({
        where: { toolId: tool.id },
        create: {
          builtin: true,
          description: tool.description,
          enabled: true,
          handlerKind: 'builtin',
          label: tool.label,
          safe: tool.safe,
          toolId: tool.id,
        },
        update: {
          builtin: true,
          description: tool.description,
          handlerKind: 'builtin',
          label: tool.label,
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
  await ensureBuiltinToolsRegistered(prisma)

  const entries = await prisma.toolRegistryEntry.findMany({
    where: {
      OR: [{ organizationId: null }, { organizationId }],
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
  const entry = await prisma.toolRegistryEntry.upsert({
    where: { toolId: input.toolId },
    create: {
      organizationId: input.builtin ? null : organizationId,
      toolId: input.toolId,
      label: input.label,
      description: input.description,
      safe: input.safe ?? false,
      builtin: input.builtin ?? false,
      enabled: input.enabled ?? true,
      handlerKind: input.handlerKind ?? 'builtin',
      metadata: (toInputJsonObject(input.metadata) ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      organizationId: input.builtin ? null : organizationId,
      label: input.label,
      description: input.description,
      safe: input.safe ?? false,
      builtin: input.builtin ?? false,
      enabled: input.enabled ?? true,
      handlerKind: input.handlerKind ?? 'builtin',
      metadata: (toInputJsonObject(input.metadata) ?? {}) as Prisma.InputJsonValue,
    },
  })

  return mapToolRegistryEntry(entry)
}
