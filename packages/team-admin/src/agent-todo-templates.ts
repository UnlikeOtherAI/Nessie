import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentTodoTemplateRecordSchema,
  type AgentTodoActorType,
  type AgentTodoTemplateRecord,
  type AgentTodoTemplateStatus,
  type AgentTodoTemplateStepInput,
} from '@nessie/schemas'

import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
} from './agent-todo-errors.js'
import {
  mapAgentTodoTemplateRecord,
  prepareAgentTodoSteps,
  prepareEditedAgentTodoSteps,
} from './agent-todo-records.js'
import { acquireAgentTodoAgentLock } from './agent-todo-lock.js'

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
    version: number
  },
): Promise<AgentTodoTemplateRecord | null> => {
  const existing = await getAgentTodoTemplate(prisma, input)
  if (!existing) return null

  const steps = input.steps
    ? prepareEditedAgentTodoSteps(existing.steps, input.steps)
    : undefined
  const changed = await prisma.agentTodoTemplate.updateMany({
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
    where: {
      agentId: input.agentId,
      id: existing.id,
      organizationId: input.organizationId,
      version: input.version,
    },
  })
  if (changed.count === 0) {
    throw new AgentTodoError(
      AGENT_TODO_ERROR_CODES.TEMPLATE_CHANGED,
      'This to-do template changed before your edit could be saved. Refresh and try again.',
    )
  }
  return getAgentTodoTemplate(prisma, input)
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
  if ('$transaction' in prisma) return prisma.$transaction((tx) => archiveAgentTodoTemplate(tx, input))
  await acquireAgentTodoAgentLock(prisma, input.agentId)
  const enabledReferences = await prisma.agentTrigger.findMany({
    select: { config: true },
    where: { agentId: input.agentId, enabled: true },
  })
  if (enabledReferences.some((trigger) => {
    const config = trigger.config
    return typeof config === 'object'
      && config !== null
      && !Array.isArray(config)
      && config['todoTemplateId'] === input.templateId
  })) {
    throw new AgentTodoError(
      AGENT_TODO_ERROR_CODES.TEMPLATE_IN_USE,
      'Pause the enabled schedule using this template before archiving it.',
    )
  }
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
