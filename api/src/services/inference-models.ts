import type { AuthorizedActionContext } from '@nessie/schemas'
import { ModelCapabilitySnapshotSchema } from '../contracts/inference-core.js'
import type {
  CreateInferenceModelBody,
  InferenceModelRecord,
  UpdateInferenceModelBody,
} from '../contracts/inference-control-plane.js'
import { toJsonRecord } from './contract-helpers.js'
import {
  approveInferenceEntity,
  asJsonValue,
  ensureProvider,
  mapModelRecord,
  resetApproval,
  sameJson,
  type PrismaClient,
} from './inference-control-plane-core.js'

export const listInferenceModels = async (
  prisma: PrismaClient,
  organizationId: string,
  providerId?: string,
): Promise<InferenceModelRecord[]> => {
  const models = await prisma.inferenceModel.findMany({
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
  return models.map(mapModelRecord)
}

export const getInferenceModel = async (
  prisma: PrismaClient,
  organizationId: string,
  modelId: string,
): Promise<InferenceModelRecord | null> => {
  const model = await prisma.inferenceModel.findFirst({
    where: { id: modelId, organizationId },
  })
  return model ? mapModelRecord(model) : null
}

export const createInferenceModel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInferenceModelBody,
): Promise<InferenceModelRecord> => {
  const provider = await ensureProvider(
    prisma,
    actorContext.tenant.organizationId,
    input.providerId,
  )
  if (!provider) {
    throw new Error('INFERENCE_PROVIDER_NOT_FOUND')
  }

  const snapshot = ModelCapabilitySnapshotSchema.parse(input.capabilitySnapshot)
  if (snapshot.provider !== provider.providerKey || snapshot.model !== input.model) {
    throw new Error('INFERENCE_MODEL_CAPABILITY_SNAPSHOT_MISMATCH')
  }

  const model = await prisma.inferenceModel.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      providerId: provider.id,
      model: input.model,
      displayName: input.displayName ?? null,
      enabled: input.enabled ?? false,
      lifecycleStatus: 'draft',
      capabilitySnapshot: asJsonValue(snapshot),
      source: input.source ?? 'manual',
      discoveredAt: input.discoveredAt ? new Date(input.discoveredAt) : new Date(),
      lastVerifiedAt: input.lastVerifiedAt ? new Date(input.lastVerifiedAt) : null,
      createdByActorId: actorContext.actor.actorId,
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapModelRecord(model)
}

export const updateInferenceModel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  modelId: string,
  input: UpdateInferenceModelBody,
): Promise<InferenceModelRecord | null> => {
  const model = await prisma.inferenceModel.findFirst({
    where: {
      id: modelId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!model) {
    return null
  }
  const currentSnapshot = ModelCapabilitySnapshotSchema.parse(
    toJsonRecord(model.capabilitySnapshot),
  )

  const nextCapabilitySnapshot = input.capabilitySnapshot
    ? ModelCapabilitySnapshotSchema.parse(input.capabilitySnapshot)
    : undefined
  if (
    nextCapabilitySnapshot &&
    (nextCapabilitySnapshot.provider !== currentSnapshot.provider ||
      nextCapabilitySnapshot.model !== model.model)
  ) {
    throw new Error('INFERENCE_MODEL_CAPABILITY_SNAPSHOT_MISMATCH')
  }

  const materialChanged =
    (nextCapabilitySnapshot !== undefined &&
      !sameJson(nextCapabilitySnapshot, currentSnapshot)) ||
    (input.source !== undefined && input.source !== model.source) ||
    (input.discoveredAt !== undefined &&
      new Date(input.discoveredAt).toISOString() !== model.discoveredAt.toISOString()) ||
    (input.lastVerifiedAt !== undefined &&
      (input.lastVerifiedAt === null
        ? model.lastVerifiedAt !== null
        : new Date(input.lastVerifiedAt).toISOString() !==
          model.lastVerifiedAt?.toISOString()))

  const updated = await prisma.inferenceModel.update({
    where: { id: model.id },
    data: {
      displayName: input.displayName === undefined ? model.displayName : input.displayName,
      enabled: input.enabled ?? model.enabled,
      capabilitySnapshot:
        nextCapabilitySnapshot !== undefined
          ? asJsonValue(nextCapabilitySnapshot)
          : asJsonValue(model.capabilitySnapshot),
      source: input.source ?? model.source,
      discoveredAt: input.discoveredAt ? new Date(input.discoveredAt) : model.discoveredAt,
      lastVerifiedAt:
        input.lastVerifiedAt === undefined
          ? model.lastVerifiedAt
          : input.lastVerifiedAt === null
            ? null
            : new Date(input.lastVerifiedAt),
      ...(materialChanged ? resetApproval(actorContext.actor.actorId) : {}),
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapModelRecord(updated)
}

export const approveInferenceModel = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  modelId: string,
): Promise<InferenceModelRecord | null> =>
  approveInferenceEntity(
    prisma.inferenceModel,
    actorContext.tenant.organizationId,
    modelId,
    actorContext.actor.actorId,
    mapModelRecord,
  )
