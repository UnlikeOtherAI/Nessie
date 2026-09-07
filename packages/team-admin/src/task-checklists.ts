import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentTodoTemplateStepsSchema,
  type TaskChecklistRecord,
} from '@nessie/schemas'

type PrismaLike = PrismaClient | Prisma.TransactionClient

const include = { steps: { orderBy: { sequence: 'asc' as const } } } satisfies Prisma.TaskChecklistInclude
type ChecklistRow = Prisma.TaskChecklistGetPayload<{ include: typeof include }>

const present = (row: ChecklistRow): TaskChecklistRecord => ({
  id: row.id,
  taskId: row.taskId,
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
  try {
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
    return present(created)
  } catch (error) {
    // The unique task binding is the concurrency fence. A second click observes
    // the first complete snapshot instead of replacing progress.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const checklist = await getTaskChecklist(prisma, input)
      if (checklist) return checklist
    }
    throw error
  }
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
  return checklist ? present(checklist) : null
}
