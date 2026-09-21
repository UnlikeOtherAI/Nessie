import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient
export type LocalInferenceAdmissionRef = { admissionId: string; fence: string; resourceId: string }
type AdmissionResult = { kind: 'admitted'; admission: LocalInferenceAdmissionRef }
  | { kind: 'waiting'; reason: 'resource_missing' | 'resource_paused' | 'termination_uncertain' | 'capacity' }

const lockResource = async (tx: Tx, resourceId: string): Promise<void> => {
  await tx.$queryRaw`SELECT id FROM local_inference_resources WHERE id = ${resourceId}::uuid FOR UPDATE`
}

/** All callers serialize against the resource row, including task item claims. */
export const reserveLocalInferenceResource = async (
  tx: Tx,
  input: { resourceId: string; reservationKey: string; runId?: string },
): Promise<AdmissionResult> => {
  await lockResource(tx, input.resourceId)
  const resource = await tx.localInferenceResource.findUnique({ where: { id: input.resourceId } })
  if (!resource) return { kind: 'waiting', reason: 'resource_missing' }
  if (resource.pausedAt) return { kind: 'waiting', reason: 'resource_paused' }
  if (resource.healthReason) return { kind: 'waiting', reason: 'termination_uncertain' }
  const existing = await tx.inferenceResourceAdmission.findUnique({ where: { reservationKey: input.reservationKey } })
  if (existing) {
    if (existing.resourceId !== input.resourceId || existing.runId !== (input.runId ?? null)) {
      throw new Error('Inference resource reservation identity conflict.')
    }
    if (existing.state === 'uncertain') return { kind: 'waiting', reason: 'termination_uncertain' }
    if (existing.state === 'released') throw new Error('A released inference reservation cannot be reused.')
    return { kind: 'admitted', admission: { admissionId: existing.id, fence: existing.fence, resourceId: existing.resourceId } }
  }
  const occupied = await tx.inferenceResourceAdmission.count({
    where: { resourceId: input.resourceId, state: { not: 'released' } },
  })
  if (occupied >= resource.capacity) return { kind: 'waiting', reason: 'capacity' }
  const row = await tx.inferenceResourceAdmission.create({
    data: {
      fence: randomUUID(), reservationKey: input.reservationKey, resourceId: input.resourceId,
      runId: input.runId ?? null, state: 'reserved',
    },
  })
  return { kind: 'admitted', admission: { admissionId: row.id, fence: row.fence, resourceId: row.resourceId } }
}

/** A task item retains its reservation between utility/main model calls. */
export const claimLocalInferenceAttemptAdmission = async (
  tx: Tx,
  input: { attemptId: string; runId: string; resourceId: string },
): Promise<AdmissionResult> => {
  await lockResource(tx, input.resourceId)
  const resource = await tx.localInferenceResource.findUnique({ where: { id: input.resourceId } })
  if (!resource) return { kind: 'waiting', reason: 'resource_missing' }
  if (resource.pausedAt) return { kind: 'waiting', reason: 'resource_paused' }
  if (resource.healthReason) return { kind: 'waiting', reason: 'termination_uncertain' }
  const run = await tx.run.findUnique({ where: { id: input.runId }, select: { inferenceResourceAdmissionId: true } })
  const pinned = run?.inferenceResourceAdmissionId
    ? await tx.inferenceResourceAdmission.findUnique({ where: { id: run.inferenceResourceAdmissionId } })
    : null
  const result = pinned
    ? { kind: 'admitted' as const, admission: { admissionId: pinned.id, fence: pinned.fence, resourceId: pinned.resourceId } }
    : await reserveLocalInferenceResource(tx, {
      reservationKey: `local-attempt:${input.attemptId}`, resourceId: input.resourceId, runId: input.runId,
    })
  if (result.kind !== 'admitted') return result
  if (pinned && (pinned.resourceId !== input.resourceId || pinned.runId !== input.runId)) {
    throw new Error('Run inference resource reservation does not match its processor.')
  }
  const updated = await tx.inferenceResourceAdmission.updateMany({
    where: { id: result.admission.admissionId, state: 'reserved', attemptId: null },
    data: { attemptId: input.attemptId, confirmedAt: null, state: 'running' },
  })
  if (updated.count !== 1) {
    return { kind: 'waiting', reason: pinned?.state === 'uncertain' ? 'termination_uncertain' : 'capacity' }
  }
  await tx.localInferenceAttempt.update({
    where: { id: input.attemptId }, data: { resourceAdmissionId: result.admission.admissionId },
  })
  return result
}

/** Expiry/cancellation is never a substitute for the host's terminal proof. */
export const settleLocalInferenceAttemptAdmission = async (
  tx: Tx,
  input: LocalInferenceAdmissionRef & { attemptId: string; confirmed: boolean },
): Promise<boolean> => {
  await lockResource(tx, input.resourceId)
  const admission = await tx.inferenceResourceAdmission.findUnique({ where: { id: input.admissionId } })
  if (!admission || admission.resourceId !== input.resourceId || admission.fence !== input.fence) return false
  if (admission.attemptId !== input.attemptId) {
    // Exact completed-attempt replay stays harmless even when a task's next
    // invocation has borrowed the reservation. Never settle that new call.
    const attempt = await tx.localInferenceAttempt.findUnique({
      where: { id: input.attemptId }, select: { resourceAdmissionId: true },
    })
    return input.confirmed && attempt?.resourceAdmissionId === admission.id
  }
  if (!input.confirmed) {
    await tx.inferenceResourceAdmission.update({ where: { id: admission.id }, data: { state: 'uncertain' } })
    await tx.localInferenceResource.update({ where: { id: input.resourceId }, data: { healthReason: 'termination_uncertain' } })
    return true
  }
  const run = admission.runId ? await tx.run.findUnique({
    where: { id: admission.runId }, select: { inferenceResourceAdmissionId: true },
  }) : null
  await tx.inferenceResourceAdmission.update({
    where: { id: admission.id },
    data: {
      attemptId: null, confirmedAt: new Date(),
      state: run?.inferenceResourceAdmissionId === admission.id ? 'reserved' : 'released',
    },
  })
  const uncertain = await tx.inferenceResourceAdmission.count({ where: { resourceId: input.resourceId, state: 'uncertain' } })
  if (uncertain === 0) {
    await tx.localInferenceResource.update({ where: { id: input.resourceId }, data: { healthReason: null } })
  }
  return true
}

/** The item owner calls this after committing its result/effects. Never frees a live call. */
export const releaseLocalInferenceResource = async (tx: Tx, input: { admissionId: string }): Promise<boolean> => {
  const admission = await tx.inferenceResourceAdmission.findUnique({ where: { id: input.admissionId } })
  if (!admission) return false
  await lockResource(tx, admission.resourceId)
  const updated = await tx.inferenceResourceAdmission.updateMany({
    where: { id: admission.id, state: 'reserved', attemptId: null }, data: { state: 'released' },
  })
  return updated.count === 1
}
