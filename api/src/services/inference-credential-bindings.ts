import type { AuthorizedActionContext } from '@nessie/schemas'
import type {
  CreateInferenceCredentialBindingBody,
  InferenceCredentialBindingRecord,
} from '../contracts/inference-control-plane.js'
import {
  ensureProvider,
  mapCredentialBindingRecord,
  type PrismaClient,
} from './inference-control-plane-core.js'

/**
 * Phase-0 secret-custody gate (security boundary hardening, Workstream 2, S2).
 *
 * The worker resolves a binding's `authSecretRef` as `process.env[ref]`, so a
 * caller-chosen ref would bind any deployment secret (DATABASE_URL, signing
 * keys, ...) as a bearer token to the caller's own endpoint. Until the
 * secret-store (`secret_*`) refs land, the control plane refuses new
 * caller-supplied env refs server-side. Persisted (grandfathered) rows are
 * untouched and keep resolving through the worker; the contract shape is
 * unchanged so old clients keep parsing. Operators configure inference
 * credentials at the deployment level.
 */
export class InferenceEnvRefForbiddenError extends Error {
  readonly code = 'INFERENCE_ENV_REF_FORBIDDEN'
  constructor() {
    super('INFERENCE_ENV_REF_FORBIDDEN')
    this.name = 'InferenceEnvRefForbiddenError'
  }
}

export const listInferenceCredentialBindings = async (
  prisma: PrismaClient,
  organizationId: string,
  providerId?: string,
): Promise<InferenceCredentialBindingRecord[]> => {
  const bindings = await prisma.inferenceCredentialBinding.findMany({
    where: providerId
      ? {
          organizationId,
          providerId,
        }
      : {
          organizationId,
        },
    orderBy: [{ createdAt: 'desc' }],
  })
  return bindings.map(mapCredentialBindingRecord)
}

export const createInferenceCredentialBinding = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInferenceCredentialBindingBody,
): Promise<InferenceCredentialBindingRecord> => {
  // Every credential-binding create carries a caller-chosen env ref, so the
  // write path is refused outright. Grandfathered rows keep working through
  // the worker resolver; this gate never touches existing rows.
  if (typeof input.authSecretRef === 'string' && input.authSecretRef.length > 0) {
    throw new InferenceEnvRefForbiddenError()
  }
  const provider = await ensureProvider(
    prisma,
    actorContext.tenant.organizationId,
    input.providerId,
  )
  if (!provider) {
    throw new Error('INFERENCE_PROVIDER_NOT_FOUND')
  }

  const binding = await prisma.inferenceCredentialBinding.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      providerId: provider.id,
      label: input.label,
      authSecretRef: input.authSecretRef,
      createdByActorId: actorContext.actor.actorId,
    },
  })

  return mapCredentialBindingRecord(binding)
}

export const revokeInferenceCredentialBinding = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  bindingId: string,
): Promise<InferenceCredentialBindingRecord | null> => {
  const binding = await prisma.inferenceCredentialBinding.findFirst({
    where: {
      id: bindingId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!binding) {
    return null
  }

  const updated = await prisma.$transaction(async (tx) => {
    const db = tx as PrismaClient

    const revoked = await db.inferenceCredentialBinding.update({
      where: { id: binding.id },
      data: {
        revokedAt: new Date(),
      },
    })

    await db.inferenceProvider.updateMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        activeCredentialBindingId: binding.id,
      },
      data: {
        activeCredentialBindingId: null,
        updatedByActorId: actorContext.actor.actorId,
      },
    })

    return revoked
  })

  return mapCredentialBindingRecord(updated)
}
