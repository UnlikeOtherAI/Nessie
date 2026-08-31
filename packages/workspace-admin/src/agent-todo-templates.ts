import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentTodoTemplateRecordSchema,
  type AgentTodoActorType,
  type AgentTodoTemplateRecord,
  type AgentTodoTemplateStatus,
  type AgentTodoTemplateStepInput,
} from '@nessie/schemas'

import {
  mapAgentTodoTemplateRecord,
  prepareAgentTodoSteps,
  prepareEditedAgentTodoSteps,
} from './agent-todo-records.js'

type PrismaLike = PrismaClient | Prisma.TransactionClient

type AgentTodoTemplateIdentity = {
  agentId: string
  organizationId: string
}

export const listAgentTodoTemplates = async (
  prisma: PrismaLike,
  input: AgentTodoTemplateIdentity & { includeArchived?: boolean },
): Promise<AgentTodoTemplateRecord[]> => {
  const rows = await prisma.agentTodoTemplate.findMany({
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    where: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      ...(input.includeArchived ? {} : { status: { not: 'archived' as const } }),
    },
  })
  return rows.map(mapAgentTodoTemplateRecord)
}

export const getAgentTodoTemplate = async (
  prisma: PrismaLike,
  input: AgentTodoTemplateIdentity & { templateId: string },
): Promise<AgentTodoTemplateRecord | null> => {
  const row = await prisma.agentTodoTemplate.findFirst({
    where: {
      agentId: input.agentId,
      id: input.templateId,
      organizationId: input.organizationId,
    },
  })
  return row ? mapAgentTodoTemplateRecord(row) : null
}

export const createAgentTodoTemplate = async (
  prisma: PrismaLike,
  input: AgentTodoTemplateIdentity & {
    authorType: AgentTodoActorType
    createdByUserId: string | null
    description?: string | null
    name: string
    proposedByRunId: string | null
    status: AgentTodoTemplateStatus
    steps: readonly AgentTodoTemplateStepInput[]
  },
): Promise<AgentTodoTemplateRecord> => {
  const steps = prepareAgentTodoSteps(input.steps)
  const row = await prisma.agentTodoTemplate.create({
    data: {
      agentId: input.agentId,
      authorType: input.authorType,
      createdByUserId: input.createdByUserId,
      description: input.description ?? null,
      name: AgentTodoTemplateRecordSchema.shape.name.parse(input.name),
      organizationId: input.organizationId,
      proposedByRunId: input.proposedByRunId,
      status: input.status,
      steps: steps as Prisma.InputJsonValue,
    },
  })
  return mapAgentTodoTemplateRecord(row)
}

export const updateAgentTodoTemplate = async (
  prisma: PrismaLike,
  input: AgentTodoTemplateIdentity & {
    createdByUserId: string
    description?: string | null
    name?: string
    steps?: readonly AgentTodoTemplateStepInput[]
    templateId: string
  },
): Promise<AgentTodoTemplateRecord | null> => {
  const existing = await getAgentTodoTemplate(prisma, input)
  if (!existing) return null

  const steps = input.steps
    ? prepareEditedAgentTodoSteps(existing.steps, input.steps)
    : undefined
  const row = await prisma.agentTodoTemplate.update({
    data: {
      authorType: 'user',
      createdByUserId: input.createdByUserId,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.name !== undefined
        ? { name: AgentTodoTemplateRecordSchema.shape.name.parse(input.name) }
        : {}),
      ...(steps ? { steps: steps as Prisma.InputJsonValue } : {}),
      version: { increment: 1 },
    },
    where: { id: existing.id },
  })
  return mapAgentTodoTemplateRecord(row)
}

/**
 * Version and draft status live in the UPDATE predicate so an approval can
 * never publish a different version from the one a person reviewed.
 */
export const activateAgentTodoTemplate = async (
  prisma: PrismaLike,
  input: AgentTodoTemplateIdentity & { templateId: string; version: number },
): Promise<AgentTodoTemplateRecord | null> => {
  const changed = await prisma.agentTodoTemplate.updateMany({
    data: { status: 'active' },
    where: {
      agentId: input.agentId,
      id: input.templateId,
      organizationId: input.organizationId,
      status: 'draft',
      version: input.version,
    },
  })
  if (changed.count === 0) return null
  return getAgentTodoTemplate(prisma, input)
}

export const archiveAgentTodoTemplate = async (
  prisma: PrismaLike,
  input: AgentTodoTemplateIdentity & { templateId: string },
): Promise<AgentTodoTemplateRecord | null> => {
  const changed = await prisma.agentTodoTemplate.updateMany({
    data: { status: 'archived' },
    where: {
      agentId: input.agentId,
      id: input.templateId,
      organizationId: input.organizationId,
    },
  })
  if (changed.count === 0) return null
  return getAgentTodoTemplate(prisma, input)
}
