import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'

type AttentionTransaction = Pick<
  Prisma.TransactionClient,
  'organizationMember' | 'projectMember' | 'userAlert' | '$executeRaw'
>

const retireSupersededTaskAttention = async (
  tx: AttentionTransaction,
  input: { eventKey: string; organizationId: string; taskId: string },
): Promise<void> => {
  await tx.userAlert.updateMany({
    where: {
      kind: 'task_assigned', organizationId: input.organizationId, readAt: null, taskId: input.taskId,
      OR: [{ eventKey: { not: input.eventKey } }, { eventKey: null }],
    },
    data: { readAt: new Date() },
  })
}

/** The attention side effect shared by clicked and assistant ticket assignment. */
export const createProjectTaskAssignmentAttention = async (
  tx: AttentionTransaction,
  input: {
    actorUserId: string
    assigneeUserId: string | null
    eventKey: string
    organizationId: string
    projectId: string | null
    taskId: string
  },
): Promise<void> => {
  await retireSupersededTaskAttention(tx, input)
  if (!input.assigneeUserId || !input.projectId || input.assigneeUserId === input.actorUserId) return
  const [organizationMember, projectMember] = await Promise.all([
    tx.organizationMember.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.assigneeUserId,
        deactivatedAt: null,
      },
      select: { id: true },
    }),
    tx.projectMember.findFirst({
      where: { projectId: input.projectId, userId: input.assigneeUserId },
      select: { id: true },
    }),
  ])
  if (!organizationMember || !projectMember) return
  const alert = await tx.userAlert.upsert({
    where: { userId_eventKey: { eventKey: input.eventKey, userId: input.assigneeUserId } },
    create: { actorUserId: input.actorUserId, eventKey: input.eventKey, kind: 'task_assigned', organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId, userId: input.assigneeUserId },
    update: {}, select: { id: true },
  })
  await enqueueQueueJob(tx, { idempotencyKey: `attention:${alert.id}`, payload: { alertId: alert.id }, topic: 'attention.dispatch' })
}
