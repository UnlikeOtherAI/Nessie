import type { Iteration, PrismaClient } from '@prisma/client'
import { parseProjectId } from '@nessie/schemas'
import type { IterationRecord, ProjectInsightsRecord } from '../contracts.js'

type IterationStats = { taskCount: number; pointsTotal: number; pointsDone: number }

const iterationStats = async (
  prisma: PrismaClient,
  iterationId: string,
): Promise<IterationStats> => {
  const totals = await prisma.task.aggregate({
    where: { iterationId },
    _sum: { storyPoints: true },
    _count: { _all: true },
  })
  const done = await prisma.task.aggregate({
    where: { iterationId, status: 'done' },
    _sum: { storyPoints: true },
  })
  return {
    taskCount: totals._count._all,
    pointsTotal: totals._sum.storyPoints ?? 0,
    pointsDone: done._sum.storyPoints ?? 0,
  }
}

const mapIteration = (iteration: Iteration, stats: IterationStats): IterationRecord => ({
  id: iteration.id,
  projectId: parseProjectId(iteration.projectId),
  name: iteration.name,
  goal: iteration.goal,
  status: iteration.status,
  startDate: iteration.startDate ? iteration.startDate.toISOString() : null,
  endDate: iteration.endDate ? iteration.endDate.toISOString() : null,
  capacity: iteration.capacity,
  position: iteration.position,
  completedAt: iteration.completedAt ? iteration.completedAt.toISOString() : null,
  ...stats,
})

const withStats = async (prisma: PrismaClient, iteration: Iteration): Promise<IterationRecord> =>
  mapIteration(iteration, await iterationStats(prisma, iteration.id))

export const listIterations = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<IterationRecord[]> => {
  const iterations = await prisma.iteration.findMany({
    where: { projectId },
    orderBy: { position: 'asc' },
  })
  return Promise.all(iterations.map((iteration) => withStats(prisma, iteration)))
}

export const createIteration = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  input: { name: string; goal?: string; startDate?: string; endDate?: string; capacity?: number },
): Promise<IterationRecord> => {
  const position =
    ((await prisma.iteration.aggregate({
      where: { projectId: project.id },
      _max: { position: true },
    }))._max.position ?? -1) + 1
  const iteration = await prisma.iteration.create({
    data: {
      projectId: project.id,
      organizationId: project.organizationId,
      name: input.name,
      goal: input.goal ?? null,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      capacity: input.capacity ?? null,
      position,
    },
  })
  return withStats(prisma, iteration)
}

type UpdateIterationInput = {
  name?: string
  goal?: string | null
  startDate?: string | null
  endDate?: string | null
  capacity?: number | null
  action?: 'start' | 'complete'
}

type IterationError = { error: 'NOT_FOUND' | 'ALREADY_ACTIVE' }

export const updateIteration = async (
  prisma: PrismaClient,
  projectId: string,
  iterationId: string,
  input: UpdateIterationInput,
): Promise<IterationRecord | IterationError> => {
  const existing = await prisma.iteration.findFirst({
    where: { id: iterationId, projectId },
    select: { id: true, status: true, position: true },
  })
  if (!existing) return { error: 'NOT_FOUND' }

  const data: Record<string, unknown> = {}
  if (input.name !== undefined) data.name = input.name
  if (input.goal !== undefined) data.goal = input.goal
  if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null
  if (input.endDate !== undefined) data.endDate = input.endDate ? new Date(input.endDate) : null
  if (input.capacity !== undefined) data.capacity = input.capacity

  if (input.action === 'start') {
    const otherActive = await prisma.iteration.findFirst({
      where: { projectId, status: 'active', id: { not: iterationId } },
      select: { id: true },
    })
    if (otherActive) return { error: 'ALREADY_ACTIVE' }
    data.status = 'active'
  }

  if (input.action === 'complete') {
    data.status = 'completed'
    data.completedAt = new Date()
    // Carry over unfinished work to the next planned iteration, or the backlog.
    const next = await prisma.iteration.findFirst({
      where: { projectId, status: 'planned', position: { gt: existing.position } },
      orderBy: { position: 'asc' },
      select: { id: true },
    })
    await prisma.task.updateMany({
      where: { iterationId, status: { not: 'done' } },
      data: { iterationId: next?.id ?? null },
    })
  }

  const updated = await prisma.iteration.update({ where: { id: iterationId }, data })
  return withStats(prisma, updated)
}

export const deleteIteration = async (
  prisma: PrismaClient,
  projectId: string,
  iterationId: string,
): Promise<boolean> => {
  const result = await prisma.iteration.deleteMany({ where: { id: iterationId, projectId } })
  return result.count > 0
}

const DAY_MS = 86_400_000

const toUtcDay = (date: Date): number =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())

// Velocity (points delivered per completed sprint) + an active-sprint burndown
// derived from the task status-changed→done events (no snapshot table needed).
export const getProjectInsights = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<ProjectInsightsRecord> => {
  const iterations = await prisma.iteration.findMany({
    where: { projectId },
    orderBy: { position: 'asc' },
  })

  const velocity = await Promise.all(
    iterations
      .filter((iteration) => iteration.status === 'completed')
      .map(async (iteration) => ({
        iterationId: iteration.id,
        name: iteration.name,
        points:
          (
            await prisma.task.aggregate({
              where: { iterationId: iteration.id, status: 'done' },
              _sum: { storyPoints: true },
            })
          )._sum.storyPoints ?? 0,
      })),
  )

  const active = iterations.find((iteration) => iteration.status === 'active')
  let burndown: ProjectInsightsRecord['burndown'] = null

  if (active && active.startDate && active.endDate) {
    const tasks = await prisma.task.findMany({
      where: { iterationId: active.id },
      select: { id: true, storyPoints: true, status: true },
    })
    const totalPoints = tasks.reduce((sum, task) => sum + (task.storyPoints ?? 0), 0)
    const pointsByTask = new Map(tasks.map((task) => [task.id, task.storyPoints ?? 0]))

    const doneTaskIds = tasks.filter((task) => task.status === 'done').map((task) => task.id)
    const events = doneTaskIds.length
      ? await prisma.taskEvent.findMany({
          where: { taskId: { in: doneTaskIds }, eventType: 'status_changed' },
          orderBy: { createdAt: 'asc' },
        })
      : []
    // The day each currently-done task reached 'done' (latest such transition).
    const doneDayByTask = new Map<string, number>()
    for (const event of events) {
      if ((event.payload as { to?: string } | null)?.to === 'done') {
        doneDayByTask.set(event.taskId, toUtcDay(event.createdAt))
      }
    }

    const startDay = toUtcDay(active.startDate)
    const endDay = toUtcDay(active.endDate)
    const totalDays = Math.max(1, Math.round((endDay - startDay) / DAY_MS))
    const days = []
    for (let index = 0; index <= totalDays; index += 1) {
      const day = startDay + index * DAY_MS
      let donePoints = 0
      for (const [taskId, doneDay] of doneDayByTask) {
        if (doneDay <= day) donePoints += pointsByTask.get(taskId) ?? 0
      }
      days.push({
        date: new Date(day).toISOString().slice(0, 10),
        remaining: totalPoints - donePoints,
        ideal: Math.round(totalPoints * (1 - index / totalDays) * 10) / 10,
      })
    }
    burndown = { iterationId: active.id, name: active.name, totalPoints, days }
  }

  return { velocity, burndown }
}
