import type { Prisma } from '@prisma/client'
import type { LocalInferenceResourceControl, LocalInferenceResourceAttachment } from '@nessie/schemas'
import { verifyLocalInferenceResourceAttachment } from '@nessie/local-inference-host'

export const resourceControl = (resource: {
  id: string; capacity: number; controlRevision: number; pausedAt: Date | null; healthReason: string | null
}): LocalInferenceResourceControl => ({
  capacity: resource.capacity, controlRevision: resource.controlRevision,
  healthReason: resource.healthReason === 'termination_uncertain' ? 'termination_uncertain' : null,
  paused: resource.pausedAt !== null, resourceId: resource.id,
})

/** Both transport authority and the shared coordinator key must prove enrollment. */
export const attachLocalInferenceResource = async (
  tx: Prisma.TransactionClient,
  input: {
    attachment: LocalInferenceResourceAttachment
    host: { id: string; organizationId: string; custodianUserId: string; connectionEpoch: number }
    controlRevision: number
    paused: boolean
    healthReason: 'termination_uncertain' | null
    action?: 'pause' | 'resume'
  },
): Promise<LocalInferenceResourceControl | null> => {
  const proof = input.attachment
  if (proof.hostId !== input.host.id || proof.organizationId !== input.host.organizationId
    || proof.connectionEpoch !== String(input.host.connectionEpoch)) return null
  const fingerprint = verifyLocalInferenceResourceAttachment(proof)
  if (!fingerprint) return null
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-inference-resource:${fingerprint}`}::text, 0))`
  let resource = await tx.localInferenceResource.findUnique({ where: { publicKeyFingerprint: fingerprint } })
  if (resource && (resource.custodianUserId !== input.host.custodianUserId
    || resource.organizationId !== input.host.organizationId)) return null
  const host = await tx.localInferenceHost.findUnique({
    where: { id: input.host.id }, select: { inferenceResourceId: true, pausedAt: true },
  })
  if (!host || host.inferenceResourceId && host.inferenceResourceId !== resource?.id) return null
  if (!resource) {
    resource = await tx.localInferenceResource.create({
      data: {
        custodianUserId: input.host.custodianUserId, organizationId: input.host.organizationId,
        publicKey: proof.publicKey, publicKeyFingerprint: fingerprint,
        pausedAt: input.paused || host.pausedAt ? new Date() : null, healthReason: input.healthReason,
      },
    })
  } else {
    await tx.$queryRaw`SELECT id FROM local_inference_resources WHERE id = ${resource.id}::uuid FOR UPDATE`
    resource = await tx.localInferenceResource.findUniqueOrThrow({ where: { id: resource.id } })
    const pause = input.action === 'pause'
      || input.paused && input.controlRevision === resource.controlRevision && resource.pausedAt === null
    const resume = input.action === 'resume'
    if (pause || resume || input.healthReason) {
      resource = await tx.localInferenceResource.update({
        where: { id: resource.id },
        data: {
          ...(pause || resume ? { pausedAt: pause ? new Date() : null, controlRevision: { increment: 1 } } : {}),
          ...(input.healthReason ? { healthReason: input.healthReason } : {}),
        },
      })
    }
  }
  await tx.localInferenceHost.update({
    where: { id: input.host.id }, data: { inferenceResourceId: resource.id, pausedAt: resource.pausedAt },
  })
  await tx.localInferenceHost.updateMany({
    where: { inferenceResourceId: resource.id }, data: { pausedAt: resource.pausedAt },
  })
  return resourceControl(resource)
}

export const controlLocalInferenceResource = async (
  tx: Prisma.TransactionClient,
  input: { hostId: string; organizationId: string; custodianUserId: string; action: 'pause' | 'resume' },
): Promise<boolean> => {
  const host = await tx.localInferenceHost.findFirst({
    where: {
      id: input.hostId, organizationId: input.organizationId, custodianUserId: input.custodianUserId, revokedAt: null,
    },
    select: { inferenceResourceId: true },
  })
  if (!host) return false
  const pausedAt = input.action === 'pause' ? new Date() : null
  if (!host.inferenceResourceId) {
    await tx.localInferenceHost.update({ where: { id: input.hostId }, data: { pausedAt } })
    return true
  }
  const resourceId = host.inferenceResourceId
  await tx.$queryRaw`SELECT id FROM local_inference_resources WHERE id = ${resourceId}::uuid FOR UPDATE`
  await tx.localInferenceResource.update({
    where: { id: host.inferenceResourceId }, data: { pausedAt, controlRevision: { increment: 1 } },
  })
  await tx.localInferenceHost.updateMany({ where: { inferenceResourceId: resourceId }, data: { pausedAt } })
  return true
}

/** Lowering capacity drains existing reservations; it never revokes a running call. */
export const setLocalInferenceResourceCapacity = async (
  tx: Prisma.TransactionClient,
  input: { hostId: string; organizationId: string; custodianUserId: string; capacity: number },
): Promise<boolean> => {
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 16) return false
  const host = await tx.localInferenceHost.findFirst({
    where: {
      id: input.hostId, organizationId: input.organizationId, custodianUserId: input.custodianUserId, revokedAt: null,
    },
    select: { inferenceResourceId: true },
  })
  const resourceId = host?.inferenceResourceId
  if (!resourceId) return false
  await tx.$queryRaw`SELECT id FROM local_inference_resources WHERE id = ${resourceId}::uuid FOR UPDATE`
  await tx.localInferenceResource.update({
    where: { id: resourceId }, data: { capacity: input.capacity, controlRevision: { increment: 1 } },
  })
  return true
}
