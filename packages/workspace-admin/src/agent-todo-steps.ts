import { Prisma, type PrismaClient } from '@prisma/client'
import {
  type AgentTodoActorType,
  type AgentTodoRecord,
  type AgentTodoStepStatus,
} from '@nessie/schemas'

import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
} from './agent-todo-errors.js'
import { getAgentTodo } from './agent-todo-instances.js'
import { acquireAgentTodoLock } from './agent-todo-lock.js'

type PrismaLike = PrismaClient | Prisma.TransactionClient

type StepAddress =
  | { key: string; stepId?: never }
  | { key?: never; stepId: string }

const TERMINAL_STEP_STATUSES: AgentTodoStepStatus[] = [
  'completed',
  'failed',
  'skipped',
]

const withTransaction = async <T>(
  prisma: PrismaLike,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if ('$transaction' in prisma) return prisma.$transaction(work)
  return work(prisma)
}

export const updateAgentTodoStep = async (
  prisma: PrismaLike,
  input: StepAddress & {
    actor: { id: string; type: AgentTodoActorType }
    agentId: string
    note?: string | null
    organizationId: string
    status: AgentTodoStepStatus
    todoId: string
  },
): Promise<AgentTodoRecord> =>
  withTransaction(prisma, async (tx) => {
    await acquireAgentTodoLock(tx, input.todoId)

    const todo = await tx.agentTodo.findFirst({
      select: { id: true, status: true },
      where: {
        agentId: input.agentId,
        id: input.todoId,
        organizationId: input.organizationId,
      },
    })
    if (!todo) {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.NOT_FOUND,
        'To-do not found.',
      )
    }
    if (todo.status === 'cancelled') {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.CANCELLED,
        'This to-do was cancelled and its steps can no longer be changed.',
      )
    }

    const step = await tx.agentTodoStep.findFirst({
      select: { id: true },
      where: {
        todoId: input.todoId,
        ...(input.stepId ? { id: input.stepId } : { key: input.key }),
      },
    })
    if (!step) {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.STEP_NOT_FOUND,
        'To-do step not found.',
      )
    }

    const completedAt = TERMINAL_STEP_STATUSES.includes(input.status)
      ? new Date()
      : null
    const data = {
      completedAt,
      ...(input.note !== undefined ? { note: input.note } : {}),
      status: input.status,
      updatedByActorId: input.actor.id,
      updatedByActorType: input.actor.type,
    }

    if (input.actor.type === 'agent') {
      const changed = await tx.agentTodoStep.updateMany({
        data,
        where: {
          id: step.id,
          NOT: {
            status: { in: TERMINAL_STEP_STATUSES },
            updatedByActorType: 'user',
          },
          todoId: input.todoId,
        },
      })
      if (changed.count === 0) {
        throw new AgentTodoError(
          AGENT_TODO_ERROR_CODES.HUMAN_TERMINAL_STATUS,
          'A person set this step\'s terminal status; the agent cannot overwrite it.',
        )
      }
    } else {
      await tx.agentTodoStep.update({ where: { id: step.id }, data })
    }

    const unfinishedSteps = await tx.agentTodoStep.count({
      where: {
        status: { notIn: TERMINAL_STEP_STATUSES },
        todoId: input.todoId,
      },
    })
    if (unfinishedSteps === 0) {
      await tx.agentTodo.update({
        data: { completedAt: new Date(), status: 'completed' },
        where: { id: input.todoId },
      })
    } else if (todo.status === 'completed') {
      await tx.agentTodo.update({
        data: { completedAt: null, status: 'open' },
        where: { id: input.todoId },
      })
    }

    const current = await getAgentTodo(tx, input)
    if (!current) {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.NOT_FOUND,
        'To-do not found.',
      )
    }
    return current
  })
