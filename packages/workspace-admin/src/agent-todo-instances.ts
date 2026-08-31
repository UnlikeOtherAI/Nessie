import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentTodoTemplateRecordSchema,
  AgentTodoTemplateStepsSchema,
  type AgentTodoRecord,
  type AgentTodoStatus,
  type AgentTodoTemplateStepInput,
} from '@nessie/schemas'

import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
} from './agent-todo-errors.js'
import {
  agentTodoWithOrderedSteps,
  mapAgentTodoRecord,
  prepareAgentTodoSteps,
} from './agent-todo-records.js'
import { acquireAgentTodoLock } from './agent-todo-lock.js'

type PrismaLike = PrismaClient | Prisma.TransactionClient

type AgentTodoIdentity = {
  agentId: string
  organizationId: string
}

const withTransaction = async <T>(
  prisma: PrismaLike,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if ('$transaction' in prisma) return prisma.$transaction(work)
  return work(prisma)
}

export const listAgentTodos = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & { status?: AgentTodoStatus },
): Promise<AgentTodoRecord[]> => {
  const rows = await prisma.agentTodo.findMany({
    include: agentTodoWithOrderedSteps,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    where: {
      agentId: input.agentId,
      organizationId: input.organizationId,
      ...(input.status ? { status: input.status } : {}),
    },
  })
  return rows.map(mapAgentTodoRecord)
}

export const getAgentTodo = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & { todoId: string },
): Promise<AgentTodoRecord | null> => {
  const row = await prisma.agentTodo.findFirst({
    include: agentTodoWithOrderedSteps,
    where: {
      agentId: input.agentId,
      id: input.todoId,
      organizationId: input.organizationId,
    },
  })
  return row ? mapAgentTodoRecord(row) : null
}

export const createAgentTodoFromTemplate = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & {
    createdByUserId: string | null
    templateId: string
  },
): Promise<AgentTodoRecord> =>
  withTransaction(prisma, async (tx) => {
    const template = await tx.agentTodoTemplate.findFirst({
      where: {
        agentId: input.agentId,
        id: input.templateId,
        organizationId: input.organizationId,
      },
    })
    if (!template || template.status !== 'active') {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.TEMPLATE_UNAVAILABLE,
        'This template is not an active template for this agent.',
      )
    }

    const steps = AgentTodoTemplateStepsSchema.parse(template.steps)
    const row = await tx.agentTodo.create({
      data: {
        agentId: input.agentId,
        createdByUserId: input.createdByUserId,
        organizationId: input.organizationId,
        templateId: template.id,
        templateVersion: template.version,
        title: template.name,
        steps: {
          create: steps.map((step, sequence) => ({
            instructions: step.instructions,
            key: step.key,
            sequence,
            title: step.title,
          })),
        },
      },
      include: agentTodoWithOrderedSteps,
    })
    return mapAgentTodoRecord(row)
  })

export const createStandaloneAgentTodo = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & {
    createdByUserId: string | null
    steps: readonly AgentTodoTemplateStepInput[]
    title: string
  },
): Promise<AgentTodoRecord> => {
  const steps = prepareAgentTodoSteps(input.steps)
  const row = await prisma.agentTodo.create({
    data: {
      agentId: input.agentId,
      createdByUserId: input.createdByUserId,
      organizationId: input.organizationId,
      title: AgentTodoTemplateRecordSchema.shape.name.parse(input.title),
      steps: {
        create: steps.map((step, sequence) => ({
          instructions: step.instructions,
          key: step.key,
          sequence,
          title: step.title,
        })),
      },
    },
    include: agentTodoWithOrderedSteps,
  })
  return mapAgentTodoRecord(row)
}

export const cancelAgentTodo = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & { todoId: string },
): Promise<AgentTodoRecord> =>
  withTransaction(prisma, async (tx) => {
    await acquireAgentTodoLock(tx, input.todoId)
    const changed = await tx.agentTodo.updateMany({
      data: { completedAt: null, status: 'cancelled' },
      where: {
        agentId: input.agentId,
        id: input.todoId,
        organizationId: input.organizationId,
        status: { in: ['open', 'running'] },
      },
    })
    if (changed.count === 0) {
      const existing = await getAgentTodo(tx, input)
      if (!existing) {
        throw new AgentTodoError(
          AGENT_TODO_ERROR_CODES.NOT_FOUND,
          'To-do not found.',
        )
      }
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.NOT_CANCELLABLE,
        'Only an open or running to-do can be cancelled.',
      )
    }

    const cancelled = await getAgentTodo(tx, input)
    if (!cancelled) {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.NOT_FOUND,
        'To-do not found.',
      )
    }
    return cancelled
  })
