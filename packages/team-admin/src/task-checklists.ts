import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentTodoTemplateStepsSchema,
  parseTaskId,
  type TaskChecklistRecord,
} from '@nessie/schemas'

type PrismaLike = PrismaClient | Prisma.TransactionClient

const include = { steps: { orderBy: { sequence: 'asc' as const } } } satisfies Prisma.TaskChecklistInclude
type ChecklistRow = Prisma.TaskChecklistGetPayload<{ include: typeof include }>

const present = (row: ChecklistRow): TaskChecklistRecord => ({
  id: row.id,
  taskId: parseTaskId(row.taskId),
  title: row.title,
  steps: row.steps.map((step) => ({
    id: step.id,
    key: step.key,
    title: step.title,
    instructions: step.instructions,
    completedAt: step.completedAt?.toISOString() ?? null,
    result: step.result,
  })),
})

export const getTaskChecklist = async (
  prisma: PrismaLike,
  input: { organizationId: string; taskId: string },
): Promise<TaskChecklistRecord | null> => {
  const checklist = await prisma.taskChecklist.findFirst({
    include,
    where: { organizationId: input.organizationId, taskId: input.taskId },
  })
  return checklist ? present(checklist) : null
}

/** Snapshot an active agent template onto a task. The unique task id makes an
 * accidental repeat idempotent and preserves every recorded result. */
export const applyTaskChecklistTemplate = async (
  prisma: PrismaLike,
  input: {
    agentId: string
    createdByUserId: string
    organizationId: string
    taskId: string
    templateId: string
  },
): Promise<TaskChecklistRecord | { error: 'TASK_NOT_FOUND' | 'TEMPLATE_UNAVAILABLE' }> => {
  if ('$transaction' in prisma) {
    try {
      return await prisma.$transaction((tx) => applyTaskChecklistTemplate(tx, input))
    } catch (error) {
      // PostgreSQL marks the transaction aborted after the unique constraint
      // race. Read the winning snapshot through the client, outside that
      // aborted transaction, rather than issuing an invalid follow-up query.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const checklist = await getTaskChecklist(prisma, input)
        if (checklist) return checklist
      }
      throw error
    }
  }
  const existing = await getTaskChecklist(prisma, input)
  if (existing) return existing
  const template = await prisma.agentTodoTemplate.findFirst({
    where: {
      agentId: input.agentId,
      id: input.templateId,
      organizationId: input.organizationId,
      status: 'active',
    },
  })
  if (!template) return { error: 'TEMPLATE_UNAVAILABLE' }
  const task = await prisma.task.findFirst({
    select: { id: true },
    where: { id: input.taskId, organizationId: input.organizationId },
  })
  if (!task) return { error: 'TASK_NOT_FOUND' }
  const steps = AgentTodoTemplateStepsSchema.parse(template.steps)
  const created = await prisma.taskChecklist.create({
    data: {
      taskId: task.id,
      organizationId: input.organizationId,
      sourceTemplateId: template.id,
      sourceTemplateVersion: template.version,
      title: template.name,
      createdByUserId: input.createdByUserId,
      steps: { create: steps.map((step, sequence) => ({ ...step, sequence })) },
    },
    include,
  })
  await prisma.taskEvent.create({
    data: { taskId: task.id, eventType: 'checklist_applied', payload: { checklistId: created.id } },
  })
  return present(created)
}

export const updateTaskChecklistStep = async (
  prisma: PrismaLike,
  input: {
    checklistId: string
    completed: boolean
    organizationId: string
    result?: string | null
    stepKey: string
    taskId: string
  },
): Promise<TaskChecklistRecord | null> => {
  if ('$transaction' in prisma) {
    return prisma.$transaction((tx) => updateTaskChecklistStep(tx, input))
  }
  const step = await prisma.taskChecklistStep.updateMany({
    data: {
      completedAt: input.completed ? new Date() : null,
      ...(input.result !== undefined ? { result: input.result } : {}),
    },
    where: {
      checklistId: input.checklistId,
      key: input.stepKey,
      checklist: { is: { organizationId: input.organizationId, taskId: input.taskId } },
    },
  })
  if (step.count === 0) return null
  const checklist = await prisma.taskChecklist.findUnique({ where: { id: input.checklistId }, include })
  if (checklist) {
    await prisma.taskEvent.create({
      data: { taskId: checklist.taskId, eventType: 'checklist_step_updated', payload: { stepKey: input.stepKey } },
    })
  }
  return checklist ? present(checklist) : null
}
