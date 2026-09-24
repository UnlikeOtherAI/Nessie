import { Prisma, PrismaClient } from '@prisma/client'
import { executorCodingSessionOwnerKey } from '@nessie/executor-manage'
import {
  ticketWorkCodingSessionContext,
  TICKET_WORK_SESSION_TOPIC,
  TicketWorkSessionJobPayloadSchema,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  TriggerTicketDispatchJobPayloadSchema,
  type TaskEventOrigin,
} from '@nessie/schemas'
import { createProjectTask, moveProjectTaskToColumn } from '@nessie/team-admin'

import {
  seedStandingPolicyWorld,
  type StandingPolicyWorld,
} from '../../../packages/team-admin/test/standing-policy-fixture.js'
import { dispatchTicketEvent } from '../../src/control/ticket-trigger-dispatch.js'
import { dispatchTicketWorkSession } from '../../src/control/ticket-work-session-wake.js'

/**
 * The world the T5 suites share (session wakes, the dequeue, a machine's
 * return): the standing-policy world with its author in a team of the
 * project, the machines it names confirmed as one policy, and the helpers a
 * ticket's life through the pool needs — a pickup by a board editor, a move,
 * the owner key of a ticket's sessions, and the session jobs the heartbeat
 * intake enqueued, dispatched as the worker's subscriber would.
 */

export const SESSION: TaskEventOrigin = { kind: 'session' }
export const LOCAL = { entitlements: { settings: null, uoaConfigured: false } }
export const MINUTE = 60_000

export type MachinesWorld = StandingPolicyWorld & { machines: string[]; policyId: string }

export const withMachinesWorld = async (
  labels: string[],
  run: (world: MachinesWorld, prisma: PrismaClient) => Promise<void>,
) => {
  const prisma = new PrismaClient()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await prisma.teamMember.create({ data: { role: 'member', teamId: world.teamId, userId: world.authorId } })
    const machines: string[] = []
    for (const label of labels) machines.push(await world.machine({ label }))
    const prepared = await world.prepare({ executorIds: machines })
    await world.confirm(prepared)
    await run({ ...world, machines, policyId: prepared.policyId }, prisma)
  } finally {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM queue_jobs WHERE payload->>'organizationId' = ${world.organizationId}
         OR payload->'actorContext'->'tenant'->>'organizationId' = ${world.organizationId}`)
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** Every dispatch job the world's moves enqueued that this suite has not run yet, run in order. */
export const drainDispatch = async (prisma: PrismaClient, world: StandingPolicyWorld, seen: Set<string>) => {
  const jobs = (await prisma.queueJob.findMany({
    where: { payload: { path: ['organizationId'], equals: world.organizationId }, topic: TRIGGER_TICKET_DISPATCH_TOPIC },
    orderBy: { enqueuedAt: 'asc' },
  })).filter((job) => !seen.has(job.id))
  for (const job of jobs) {
    seen.add(job.id)
    await dispatchTicketEvent(prisma, TriggerTicketDispatchJobPayloadSchema.parse(job.payload))
  }
}

/** Every run in the thread finished, so the next wake starts one of its own rather than pending. */
export const finishRuns = (prisma: PrismaClient, threadId: string) =>
  prisma.run.updateMany({ where: { threadId }, data: { finishedAt: new Date(), status: 'completed' } })

export const moveTo = (prisma: PrismaClient, world: StandingPolicyWorld, taskId: string, columnId: string) =>
  moveProjectTaskToColumn(prisma, {
    actorId: world.colleagueId, columnId, organizationId: world.organizationId, origin: SESSION, taskId,
  })

/** A ticket the colleague, a board editor, creates and moves into a start-work column; its pickup dispatched. */
export const pickUp = async (
  prisma: PrismaClient,
  world: StandingPolicyWorld,
  title: string,
  seen: Set<string>,
  options: { columnId?: string; priority?: 'low' | 'medium' | 'high' | 'urgent'; triggerId?: string } = {},
) => {
  const created = await createProjectTask(prisma, {
    actorContext: world.contextFor(world.colleagueId),
    createdByUserId: world.colleagueId,
    organizationId: world.organizationId,
    origin: SESSION,
    projectId: world.projectId,
    title,
  })
  if ('error' in created) throw new Error(created.error)
  // The ticket's priority as the board would already have it before the move.
  if (options.priority) await prisma.task.update({ where: { id: created.id }, data: { priority: options.priority } })
  await moveTo(prisma, world, created.id, options.columnId ?? world.columns.inProgress)
  await drainDispatch(prisma, world, seen)
  const work = await prisma.agentTicketWork.findFirstOrThrow({
    where: { taskId: created.id, triggerId: options.triggerId ?? world.triggerId },
  })
  await finishRuns(prisma, work.threadId)
  return { taskId: created.id, work }
}

/** The owner key a ticket's sessions carry on a machine, under the world's author. */
export const ticketOwnerKey = (world: StandingPolicyWorld, input: { executorId: string; policyId: string; taskId: string }) =>
  executorCodingSessionOwnerKey(input.executorId, {
    actorUserId: world.authorId, agentId: world.agentId, contextId: ticketWorkCodingSessionContext(input.policyId, input.taskId),
  })

/** The session jobs the heartbeat intake enqueued for one record, oldest first. */
export const sessionJobs = (prisma: PrismaClient, workId: string) => prisma.queueJob.findMany({
  where: { payload: { path: ['workId'], equals: workId }, topic: TICKET_WORK_SESSION_TOPIC },
  orderBy: { enqueuedAt: 'asc' },
  select: { id: true, idempotencyKey: true, payload: true },
})

/** Dispatch every session job for the record this suite has not run yet, as the subscriber would. */
export const drainSessionJobs = async (prisma: PrismaClient, workId: string, seen: Set<string>) => {
  for (const job of await sessionJobs(prisma, workId)) {
    if (seen.has(job.id)) continue
    seen.add(job.id)
    await dispatchTicketWorkSession(prisma, TicketWorkSessionJobPayloadSchema.parse(job.payload))
  }
}
