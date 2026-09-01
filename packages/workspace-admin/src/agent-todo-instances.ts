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
  AgentTodoScheduledConfigError,
  AgentTodoError,
} from './agent-todo-errors.js'
import {
  buildAccessibleThreadWhere,
  type AgentVisibilityScope,
} from './agent-record.js'
import {
  agentTodoWithOrderedSteps,
  mapAgentTodoRecord,
  prepareAgentTodoSteps,
  type AgentTodoWithOrderedSteps,
} from './agent-todo-records.js'
import { acquireAgentTodoLock, acquireAgentTodoRunLock } from './agent-todo-lock.js'
import { TERMINAL_RUN_STATUSES } from './agent-todo-run-statuses.js'

type PrismaLike = PrismaClient | Prisma.TransactionClient

type AgentTodoIdentity = {
  agentId: string
  organizationId: string
}

type AgentTodoReadInput = AgentTodoIdentity & {
  visibility?: AgentVisibilityScope
}

type AgentTodoStartInput = AgentTodoIdentity & {
  runId: string
  threadId: string
} & (
    | { templateId: string; todoId?: never; title?: never; steps?: never }
    | { templateId?: never; todoId: string; title?: never; steps?: never }
    | {
        templateId?: never
        todoId?: never
        title: string
        steps: readonly AgentTodoTemplateStepInput[]
      }
  )

const isStandaloneTodoStart = (
  input: AgentTodoStartInput,
): input is AgentTodoIdentity & {
  runId: string
  threadId: string
  title: string
  steps: readonly AgentTodoTemplateStepInput[]
} => input.title !== undefined && input.steps !== undefined

const filterAgentTodoThreadLinks = async (
  prisma: PrismaLike,
  rows: readonly AgentTodoWithOrderedSteps[],
  visibility: AgentVisibilityScope | undefined,
): Promise<AgentTodoRecord[]> => {
  if (!visibility) return rows.map((row) => mapAgentTodoRecord(row))

  const threadIds = rows.flatMap((row) => [
    ...(row.threadId ? [row.threadId] : []),
    ...(row.activeRun?.threadId ? [row.activeRun.threadId] : []),
  ])
  const accessibleThreadIds = new Set((await prisma.thread.findMany({
    select: { id: true },
    where: {
      ...buildAccessibleThreadWhere(visibility),
      id: { in: threadIds },
    },
  })).map((thread) => thread.id))

  return rows.map((row) => mapAgentTodoRecord(row, accessibleThreadIds))
}

const withTransaction = async <T>(
  prisma: PrismaLike,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if ('$transaction' in prisma) return prisma.$transaction(work)
  return work(prisma)
}

const refuseIfRunAlreadyHasTodo = async (
  tx: Prisma.TransactionClient,
  input: AgentTodoIdentity & { runId: string },
): Promise<void> => {
  const activeForRun = await tx.agentTodo.findFirst({
    select: { title: true },
    where: {
      activeRun: { is: { status: { notIn: TERMINAL_RUN_STATUSES } } },
      activeRunId: input.runId,
      agentId: input.agentId,
      organizationId: input.organizationId,
      status: { in: ['open', 'running'] },
    },
  })
  if (!activeForRun) return
  throw new AgentTodoError(
    AGENT_TODO_ERROR_CODES.RUN_ALREADY_HAS_TODO,
    `This run is already working on "${activeForRun.title}". Finish it or leave it for a later run before starting another to-do.`,
  )
}

export const listAgentTodos = async (
  prisma: PrismaLike,
  input: AgentTodoReadInput & { status?: AgentTodoStatus },
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
  return filterAgentTodoThreadLinks(prisma, rows, input.visibility)
}

export const getAgentTodo = async (
  prisma: PrismaLike,
  input: AgentTodoReadInput & { todoId: string },
): Promise<AgentTodoRecord | null> => {
  const row = await prisma.agentTodo.findFirst({
    include: agentTodoWithOrderedSteps,
    where: {
      agentId: input.agentId,
      id: input.todoId,
      organizationId: input.organizationId,
    },
  })
  if (!row) return null
  return (await filterAgentTodoThreadLinks(prisma, [row], input.visibility))[0] ?? null
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

/**
 * Claims a to-do only while no live run owns it. Terminal runs intentionally
 * count as unclaimed here because terminal writers outside the worker loop do
 * not all clear activeRunId.
 */
export const claimAgentTodoForRun = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & {
    runId: string
    threadId: string
    todoId: string
  },
): Promise<AgentTodoRecord> =>
  withTransaction(prisma, async (tx) => {
    await acquireAgentTodoRunLock(tx, input.runId)
    await refuseIfRunAlreadyHasTodo(tx, input)

    const claimed = await tx.agentTodo.updateMany({
      data: {
        activeRunId: input.runId,
        status: 'running',
        threadId: input.threadId,
      },
      where: {
        agentId: input.agentId,
        id: input.todoId,
        organizationId: input.organizationId,
        status: { in: ['open', 'running'] },
        OR: [
          { activeRunId: null },
          { activeRun: { is: { status: { in: TERMINAL_RUN_STATUSES } } } },
        ],
      },
    })
    if (claimed.count === 0) {
      const existing = await tx.agentTodo.findFirst({
        select: {
          activeRun: { select: { status: true } },
          activeRunId: true,
          status: true,
        },
        where: {
          agentId: input.agentId,
          id: input.todoId,
          organizationId: input.organizationId,
        },
      })
      if (!existing) {
        throw new AgentTodoError(
          AGENT_TODO_ERROR_CODES.NOT_FOUND,
          'To-do not found.',
        )
      }
      if (
        existing.activeRunId
        && existing.activeRun?.status
        && !TERMINAL_RUN_STATUSES.includes(existing.activeRun.status)
      ) {
        throw new AgentTodoError(
          AGENT_TODO_ERROR_CODES.TODO_CLAIMED,
          'This to-do is already being worked by another live run.',
        )
      }
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.TODO_UNAVAILABLE,
        'Only an open to-do can be started.',
      )
    }

    const todo = await getAgentTodo(tx, input)
    if (!todo) {
      throw new AgentTodoError(
        AGENT_TODO_ERROR_CODES.NOT_FOUND,
        'To-do not found.',
      )
    }
    return todo
  })

/**
 * The worker starts every kind of to-do through this one transaction. Existing
 * creation operations remain the source of template copying and standalone
 * step preparation; the transaction rolls a new instance back if its run lost
 * the one-active-to-do race.
 */
export const startAgentTodoForRun = async (
  prisma: PrismaLike,
  input: AgentTodoStartInput,
): Promise<AgentTodoRecord> =>
  withTransaction(prisma, async (tx) => {
    // Take the run lock before creating. Otherwise two starts in one run could
    // each create an instance before either discovers the singular claim.
    await acquireAgentTodoRunLock(tx, input.runId)
    await refuseIfRunAlreadyHasTodo(tx, input)
    let todoId: string
    if (isStandaloneTodoStart(input)) {
      todoId = (await createStandaloneAgentTodo(tx, {
        agentId: input.agentId,
        createdByUserId: null,
        organizationId: input.organizationId,
        steps: input.steps,
        title: input.title,
      })).id
    } else if (input.templateId !== undefined) {
      todoId = (await createAgentTodoFromTemplate(tx, {
        agentId: input.agentId,
        createdByUserId: null,
        organizationId: input.organizationId,
        templateId: input.templateId,
      })).id
    } else if (input.todoId !== undefined) {
      todoId = input.todoId
    } else {
      throw new Error('A to-do start needs a template, existing to-do, or standalone steps.')
    }

    return claimAgentTodoForRun(tx, {
      agentId: input.agentId,
      organizationId: input.organizationId,
      runId: input.runId,
      threadId: input.threadId,
      todoId,
    })
  })

/**
 * Materialize a scheduled template only after the actual run has claimed its
 * slot. Several pended deliveries may drain to one run; creating here makes
 * repeated fires of one template one checklist while preserving each delivery
 * in the trigger ledger. Only the first new checklist is attached to this run:
 * the others remain open facts for the model, never auto-adopted work.
 */
export const materializeScheduledAgentTodosForRun = async (
  prisma: PrismaLike,
  input: AgentTodoIdentity & {
    runId: string
    threadId: string
    templateRefs: readonly { templateId: string; triggerId: string }[]
  },
): Promise<AgentTodoRecord[]> =>
  withTransaction(prisma, async (tx) => {
    await acquireAgentTodoRunLock(tx, input.runId)
    await refuseIfRunAlreadyHasTodo(tx, input)
    const templateRefs = [...new Map(
      input.templateRefs.map((template) => [template.templateId, template]),
    ).values()]
    const templateIds = templateRefs.map((template) => template.templateId)
    const templates = await tx.agentTodoTemplate.findMany({
      where: {
        agentId: input.agentId,
        id: { in: templateIds },
        organizationId: input.organizationId,
        status: 'active',
      },
    })
    if (templates.length !== templateIds.length) {
      const present = new Set(templates.map((template) => template.id))
      const missing = templateRefs.find((template) => !present.has(template.templateId))
      throw new AgentTodoScheduledConfigError(
        missing?.templateId ?? 'unknown',
        missing?.triggerId ?? 'unknown',
      )
    }

    const todos = await Promise.all(templateRefs.map(async (template) => {
      const todo = await createAgentTodoFromTemplate(tx, {
        agentId: input.agentId,
        createdByUserId: null,
        organizationId: input.organizationId,
        templateId: template.templateId,
      })
      const updated = await tx.agentTodo.update({
        where: { id: todo.id },
        data: { triggerId: template.triggerId },
      })
      return { ...todo, triggerId: updated.triggerId }
    }))
    const first = todos[0]
    if (!first) return []
    const claimed = await claimAgentTodoForRun(tx, {
      agentId: input.agentId,
      organizationId: input.organizationId,
      runId: input.runId,
      threadId: input.threadId,
      todoId: first.id,
    })
    return [claimed, ...todos.slice(1)]
  })

export const cancelAgentTodo = async (
  prisma: PrismaLike,
  input: AgentTodoReadInput & { todoId: string },
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
