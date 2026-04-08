import type { PrismaClient } from '@prisma/client'
import {
  parseAgentCategoryId,
  parseAgentId,
  parseOrganizationId,
  parseUserId,
} from '@nessie/schemas'
import type { AgentCategoryRecord } from '../contracts.js'

type CategoryRow = {
  agents: Array<{ agentId: string }>
  authorAgentId: string | null
  createdAt: Date
  createdById: string
  description: string | null
  id: string
  name: string
  organizationId: string
  updatedAt: Date
  visibility: 'private' | 'public'
}

const mapCategory = (row: CategoryRow): AgentCategoryRecord => ({
  id: parseAgentCategoryId(row.id),
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  organizationId: parseOrganizationId(row.organizationId),
  createdById: parseUserId(row.createdById),
  authorAgentId: row.authorAgentId ? parseAgentId(row.authorAgentId) : null,
  agentIds: row.agents.map((a) => parseAgentId(a.agentId)),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const listAgentCategories = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AgentCategoryRecord[]> => {
  const rows = await prisma.agentCategory.findMany({
    where: { organizationId },
    include: { agents: { select: { agentId: true } } },
    orderBy: { name: 'asc' },
  })

  return rows.map(mapCategory)
}

export const createAgentCategory = async (
  prisma: PrismaClient,
  input: {
    authorAgentId?: string
    createdById: string
    description?: string
    name: string
    organizationId: string
    visibility: 'private' | 'public'
  },
): Promise<AgentCategoryRecord> => {
  const row = await prisma.agentCategory.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      visibility: input.visibility,
      organizationId: input.organizationId,
      createdById: input.createdById,
      authorAgentId: input.authorAgentId ?? null,
    },
    include: { agents: { select: { agentId: true } } },
  })

  return mapCategory(row)
}

export const updateAgentCategory = async (
  prisma: PrismaClient,
  categoryId: string,
  input: {
    authorAgentId?: string | null
    description?: string | null
    name?: string
    visibility?: 'private' | 'public'
  },
): Promise<AgentCategoryRecord | null> => {
  const exists = await prisma.agentCategory.findUnique({
    where: { id: categoryId },
  })
  if (!exists) return null

  const row = await prisma.agentCategory.update({
    where: { id: categoryId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.visibility !== undefined
        ? { visibility: input.visibility }
        : {}),
      ...(input.authorAgentId !== undefined
        ? { authorAgentId: input.authorAgentId }
        : {}),
    },
    include: { agents: { select: { agentId: true } } },
  })

  return mapCategory(row)
}

export const deleteAgentCategory = async (
  prisma: PrismaClient,
  categoryId: string,
): Promise<boolean> => {
  const exists = await prisma.agentCategory.findUnique({
    where: { id: categoryId },
  })
  if (!exists) return false

  await prisma.agentCategory.delete({ where: { id: categoryId } })
  return true
}

export const addAgentToCategory = async (
  prisma: PrismaClient,
  categoryId: string,
  agentId: string,
): Promise<AgentCategoryRecord | null> => {
  const exists = await prisma.agentCategory.findUnique({
    where: { id: categoryId },
  })
  if (!exists) return null

  await prisma.agentCategoryAgent.upsert({
    where: {
      categoryId_agentId: { categoryId, agentId },
    },
    create: { categoryId, agentId },
    update: {},
  })

  const row = await prisma.agentCategory.findUniqueOrThrow({
    where: { id: categoryId },
    include: { agents: { select: { agentId: true } } },
  })

  return mapCategory(row)
}

export const removeAgentFromCategory = async (
  prisma: PrismaClient,
  categoryId: string,
  agentId: string,
): Promise<boolean> => {
  const link = await prisma.agentCategoryAgent.findUnique({
    where: { categoryId_agentId: { categoryId, agentId } },
  })
  if (!link) return false

  await prisma.agentCategoryAgent.delete({
    where: { id: link.id },
  })
  return true
}
