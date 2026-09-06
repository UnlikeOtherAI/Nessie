import type { AuthorizedActionContext } from '@nessie/schemas'
import type {
  CreateInferenceProviderBody,
  InferenceProviderRecord,
  UpdateInferenceProviderBody,
} from '../contracts/inference-control-plane.js'
import type { InferenceHealthStatus } from '../contracts/inference-core.js'
import {
  approveInferenceEntity,
  assertProviderBaseUrlSafe,
  ensureCredentialBinding,
  mapProviderRecord,
  resetApproval,
  type PrismaClient,
} from './inference-control-plane-core.js'

export const listInferenceProviders = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<InferenceProviderRecord[]> => {
  const providers = await prisma.inferenceProvider.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
  })
  return providers.map(mapProviderRecord)
}

export const getInferenceProvider = async (
  prisma: PrismaClient,
  organizationId: string,
  providerId: string,
): Promise<InferenceProviderRecord | null> => {
  const provider = await prisma.inferenceProvider.findFirst({
    where: { id: providerId, organizationId },
  })
  return provider ? mapProviderRecord(provider) : null
}

export const createInferenceProvider = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInferenceProviderBody,
): Promise<InferenceProviderRecord> => {
  if (input.connectorKind === 'openai-compatible' && !input.baseUrl) {
    throw new Error('INFERENCE_PROVIDER_BASE_URL_REQUIRED')
  }
  if (input.connectorKind === 'openai-compatible' && input.enabled) {
    throw new Error('INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING')
  }
  await assertProviderBaseUrlSafe(input.baseUrl ?? null)

  const provider = await prisma.inferenceProvider.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      providerKey: input.providerKey,
      connectorKind:
        input.connectorKind === 'openai-compatible'
          ? 'openai_compatible'
          : input.connectorKind,
      displayName: input.displayName,
      baseUrl: input.baseUrl ?? null,
      supportsModelDiscovery: input.supportsModelDiscovery ?? true,
      enabled: input.enabled ?? false,
      lifecycleStatus: 'draft',
      healthStatus: 'unknown',
      createdByActorId: actorContext.actor.actorId,
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapProviderRecord(provider)
}

export const updateInferenceProvider = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  providerId: string,
  input: UpdateInferenceProviderBody,
): Promise<InferenceProviderRecord | null> => {
  const provider = await prisma.inferenceProvider.findFirst({
    where: {
      id: providerId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!provider) {
    return null
  }

  if (input.connectorKind === 'openai-compatible' && input.baseUrl === null) {
    throw new Error('INFERENCE_PROVIDER_BASE_URL_REQUIRED')
  }

  const nextConnectorKind =
    input.connectorKind === 'openai-compatible'
      ? 'openai_compatible'
      : input.connectorKind ?? provider.connectorKind
  const nextBaseUrl = input.baseUrl === undefined ? provider.baseUrl : input.baseUrl
  const nextActiveBindingId =
    input.activeCredentialBindingId === undefined
      ? provider.activeCredentialBindingId
      : input.activeCredentialBindingId

  if (nextConnectorKind === 'openai_compatible') {
    if (!nextBaseUrl || !nextActiveBindingId) {
      throw new Error('INFERENCE_PROVIDER_OPENAI_COMPATIBLE_REQUIRES_BINDING')
    }
  }

  if (input.baseUrl !== undefined) {
    await assertProviderBaseUrlSafe(nextBaseUrl)
  }

  if (input.activeCredentialBindingId) {
    const binding = await ensureCredentialBinding(
      prisma,
      actorContext.tenant.organizationId,
      input.activeCredentialBindingId,
    )
    if (!binding || binding.providerId !== provider.id || binding.revokedAt) {
      throw new Error('INFERENCE_CREDENTIAL_BINDING_NOT_FOUND')
    }
  }

  const materialChanged =
    (input.connectorKind !== undefined &&
      input.connectorKind !==
        (provider.connectorKind === 'openai_compatible'
          ? 'openai-compatible'
          : provider.connectorKind)) ||
    (input.baseUrl !== undefined && input.baseUrl !== provider.baseUrl) ||
    (input.supportsModelDiscovery !== undefined &&
      input.supportsModelDiscovery !== provider.supportsModelDiscovery) ||
    (input.activeCredentialBindingId !== undefined &&
      input.activeCredentialBindingId !== provider.activeCredentialBindingId)

  const updated = await prisma.inferenceProvider.update({
    where: { id: provider.id },
    data: {
      connectorKind: nextConnectorKind,
      displayName: input.displayName ?? provider.displayName,
      baseUrl: nextBaseUrl,
      supportsModelDiscovery:
        input.supportsModelDiscovery ?? provider.supportsModelDiscovery,
      enabled: input.enabled ?? provider.enabled,
      activeCredentialBindingId: nextActiveBindingId,
      ...(materialChanged ? resetApproval(actorContext.actor.actorId) : {}),
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapProviderRecord(updated)
}

export const approveInferenceProvider = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  providerId: string,
): Promise<InferenceProviderRecord | null> =>
  approveInferenceEntity(
    prisma.inferenceProvider,
    actorContext.tenant.organizationId,
    providerId,
    actorContext.actor.actorId,
    mapProviderRecord,
  )

export const setInferenceProviderHealth = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  providerId: string,
  input: {
    healthStatus: InferenceHealthStatus
    lastCheckedAt?: string
  },
): Promise<InferenceProviderRecord | null> => {
  const provider = await prisma.inferenceProvider.findFirst({
    where: {
      id: providerId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!provider) {
    return null
  }

  const updated = await prisma.inferenceProvider.update({
    where: { id: provider.id },
    data: {
      healthStatus: input.healthStatus,
      lastCheckedAt: input.lastCheckedAt ? new Date(input.lastCheckedAt) : new Date(),
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapProviderRecord(updated)
}
