import { randomUUID } from 'node:crypto'
import type { PrismaClient, TaskSet } from '@prisma/client'
import { lockTaskSet, taskSetJson } from '@nessie/team-admin'
import { taskSetCanonicalJson, taskSetHash, type TaskSetArtifactReceipt } from '@nessie/knowledge'
import { z } from 'zod'
import { TaskSetDisclosureSchema } from '@nessie/schemas'
import { TaskSetBlocked, TaskSetWait } from './state.js'

const Receipt = z.object({
  attachmentId: z.string().uuid(), contentHash: z.string(), filename: z.string(), mime: z.string(),
  disclosure: TaskSetDisclosureSchema,
})
const State = z.object({
  version: z.literal(1), contractHash: z.string(),
  lease: z.object({ token: z.string().uuid(), until: z.string().datetime() }).optional(),
  receipt: Receipt.optional(), deliveryFailed: z.boolean().optional(),
  disclosure: TaskSetDisclosureSchema.optional(),
}).strict()
export type TaskSetFinalizationState = z.infer<typeof State>
export type TaskSetFinalizationClaim = { set: TaskSet; state: TaskSetFinalizationState; token: string }
const LEASE_MS = 120_000
const contractHash = (set: TaskSet): string => taskSetHash(taskSetCanonicalJson({
  output: set.output, source: set.source, name: set.name,
}))
const readState = (set: TaskSet): TaskSetFinalizationState => set.outputState === null
  ? { version: 1, contractHash: contractHash(set) } : State.parse(set.outputState)

export const claimTaskSetFinalization = async (
  prisma: PrismaClient, id: string,
): Promise<TaskSetFinalizationClaim | null> => prisma.$transaction(async (tx) => {
  await lockTaskSet(tx, id)
  const set = await tx.taskSet.findUniqueOrThrow({ where: { id } })
  if (!['running', 'waiting', 'completed'].includes(set.status) || !set.inputClosedAt || set.currentItemId) return null
  if (set.status === 'completed' && set.deliveryStatus !== 'pending') return null
  if (await tx.taskSetItem.findFirst({
    where: { taskSetId: id, status: { notIn: ['completed', 'skipped'] } }, select: { id: true },
  })) return null
  const state = readState(set)
  const now = new Date()
  if (state.lease && new Date(state.lease.until) > now) throw new TaskSetWait('output_in_progress')
  if (state.contractHash !== contractHash(set)) {
    if (state.receipt || set.outputPageId) throw new TaskSetBlocked('output_configuration_changed')
    state.contractHash = contractHash(set)
  }
  const token = randomUUID()
  state.lease = { token, until: new Date(now.getTime() + LEASE_MS).toISOString() }
  await tx.taskSet.update({ where: { id }, data: {
    outputState: taskSetJson(state), nextAttemptAt: new Date(now.getTime() + LEASE_MS),
  } })
  return { set, state, token }
})

/** Short transactions fence every external boundary. No database lock spans I/O. */
export const updateTaskSetFinalization = async (
  prisma: PrismaClient, claim: TaskSetFinalizationClaim,
  patch: { receipt?: TaskSetArtifactReceipt; outputPageId?: string; deliveryFailed?: boolean;
    disclosure?: z.infer<typeof TaskSetDisclosureSchema>;
    deliveryFailure?: string;
    finished?: boolean; deliveryStatus?: 'none' | 'pending' | 'delivered' | 'blocked'; release?: boolean } = {},
): Promise<void> => prisma.$transaction(async (tx) => {
  await lockTaskSet(tx, claim.set.id)
  const set = await tx.taskSet.findUniqueOrThrow({ where: { id: claim.set.id } })
  const state = readState(set)
  if (state.lease?.token !== claim.token) throw new TaskSetWait('output_claim_lost')
  if (!patch.release && !['running', 'waiting', 'completed'].includes(set.status)) throw new TaskSetWait('paused')
  if (state.contractHash !== contractHash(set)) throw new TaskSetBlocked('output_configuration_changed')
  if (patch.receipt) state.receipt = patch.receipt
  if (patch.disclosure) state.disclosure = patch.disclosure
  if (patch.deliveryFailed !== undefined) state.deliveryFailed = patch.deliveryFailed
  if (patch.release) delete state.lease
  else state.lease = { token: claim.token, until: new Date(Date.now() + LEASE_MS).toISOString() }
  const now = new Date()
  const completing = patch.finished && set.status !== 'completed'
  const reason = patch.deliveryFailure ?? (patch.deliveryStatus ? null : set.reason)
  const healthChanged = patch.deliveryStatus !== undefined
    && (set.deliveryStatus !== patch.deliveryStatus || set.reason !== reason)
  const updated = await tx.taskSet.update({ where: { id: set.id }, data: {
    outputState: taskSetJson(state),
    ...(patch.outputPageId ? { outputPageId: patch.outputPageId } : {}),
    ...(patch.deliveryStatus ? { deliveryStatus: patch.deliveryStatus } : {}),
    ...(patch.deliveryStatus ? { reason } : {}),
    ...(completing ? { status: 'completed' } : {}),
    ...((completing || healthChanged) ? { statusChangedAt: now, revision: { increment: 1 } } : {}),
    ...(healthChanged ? { healthRevision: { increment: 1 } } : {}),
    nextAttemptAt: new Date(now.getTime() + (patch.release ? 30_000 : LEASE_MS)),
  } })
  if (patch.deliveryStatus === 'blocked' && healthChanged) await tx.userAlert.upsert({
    where: { userId_eventKey: {
      userId: set.ownerUserId, eventKey: `task-set-health:${set.id}:${updated.healthRevision}`,
    } },
    create: { organizationId: set.organizationId, userId: set.ownerUserId,
      kind: 'task_set_health', taskSetId: set.id,
      eventKey: `task-set-health:${set.id}:${updated.healthRevision}` }, update: {},
  })
  claim.state = state
  claim.set = updated
})
