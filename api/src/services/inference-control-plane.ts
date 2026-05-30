import { Prisma, type PrismaClient as PrismaDbClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { parseOrganizationId } from '@nessie/schemas'
import {
  ModelCapabilitySnapshotSchema,
  RouteGraphSchema,
} from '../contracts.js'
import type {
  CreateInferenceCredentialBindingBody,
  CreateInferenceModelBody,
  CreateInferenceProviderBody,
  CreateInferenceRoutingProfileBody,
  InferenceCredentialBindingRecord,
  InferenceHealthStatus,
  InferenceModelRecord,
  InferenceProviderRecord,
  InferenceRoutingMode,
  InferenceRoutingProfileRecord,
  RouteGraph,
  UpdateInferenceModelBody,
  UpdateInferenceProviderBody,
  UpdateInferenceRoutingProfileBody,
} from '../contracts.js'
import {
  toJsonRecord,
} from './contract-helpers.js'

// The generated Prisma client lags the schema surface during local typechecking.
// We widen it here so the control-plane helpers can compile against the current runtime client.
type PrismaClient = PrismaDbClient & Record<string, unknown>

const asJsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const toDbStreamPolicy = (
  value: 'primary-only' | 'buffered-judge' | undefined,
): 'primary_only' | 'buffered_judge' =>
  value === 'buffered-judge' ? 'buffered_judge' : 'primary_only'

const toContractStreamPolicy = (
  value: 'primary_only' | 'buffered_judge',
): 'primary-only' | 'buffered-judge' =>
  value === 'buffered_judge' ? 'buffered-judge' : 'primary-only'

const mapProviderRecord = (provider: {
  activeCredentialBindingId: string | null
  approvedAt: Date | null
  approvedByActorId: string | null
  baseUrl: string | null
  connectorKind: 'compiled' | 'openai_compatible'
  createdAt: Date
  createdByActorId: string
  displayName: string
  enabled: boolean
  healthStatus: 'degraded' | 'healthy' | 'unknown' | 'unreachable'
  id: string
  lastCheckedAt: Date | null
  lifecycleStatus: 'approved' | 'deprecated' | 'draft'
  organizationId: string
  providerKey: string
  supportsModelDiscovery: boolean
  updatedAt: Date
  updatedByActorId: string
}): InferenceProviderRecord => ({
  id: provider.id,
  organizationId: parseOrganizationId(provider.organizationId),
  providerKey: provider.providerKey,
  connectorKind:
    provider.connectorKind === 'openai_compatible' ? 'openai-compatible' : provider.connectorKind,
  displayName: provider.displayName,
  enabled: provider.enabled,
  lifecycleStatus: provider.lifecycleStatus,
  baseUrl: provider.baseUrl ?? undefined,
  supportsModelDiscovery: provider.supportsModelDiscovery,
  activeCredentialBindingId: provider.activeCredentialBindingId ?? undefined,
  healthStatus: provider.healthStatus,
  lastCheckedAt: toTimestamp(provider.lastCheckedAt),
  createdByActorId: provider.createdByActorId,
  updatedByActorId: provider.updatedByActorId,
  approvedByActorId: provider.approvedByActorId ?? undefined,
  approvedAt: toTimestamp(provider.approvedAt),
  createdAt: provider.createdAt.toISOString(),
  updatedAt: provider.updatedAt.toISOString(),
})

const mapCredentialBindingRecord = (binding: {
  authSecretRef: string
  createdAt: Date
  createdByActorId: string
  id: string
  label: string
  organizationId: string
  providerId: string
  revokedAt: Date | null
  updatedAt: Date
}): InferenceCredentialBindingRecord => ({
  id: binding.id,
  organizationId: parseOrganizationId(binding.organizationId),
  providerId: binding.providerId,
  label: binding.label,
  createdByActorId: binding.createdByActorId,
  revokedAt: toTimestamp(binding.revokedAt),
  createdAt: binding.createdAt.toISOString(),
  updatedAt: binding.updatedAt.toISOString(),
})

const mapModelRecord = (model: {
  approvedAt: Date | null
  approvedByActorId: string | null
  capabilitySnapshot: unknown
  createdAt: Date
  createdByActorId: string
  discoveredAt: Date
  displayName: string | null
  enabled: boolean
  id: string
  lifecycleStatus: 'approved' | 'deprecated' | 'draft'
  lastVerifiedAt: Date | null
  model: string
  organizationId: string
  providerId: string
  source: 'live' | 'manual' | 'static'
  updatedAt: Date
  updatedByActorId: string
}): InferenceModelRecord => ({
  id: model.id,
  organizationId: parseOrganizationId(model.organizationId),
  providerId: model.providerId,
  model: model.model,
  displayName: model.displayName ?? undefined,
  enabled: model.enabled,
  lifecycleStatus: model.lifecycleStatus,
  capabilitySnapshot: ModelCapabilitySnapshotSchema.parse(
    toJsonRecord(model.capabilitySnapshot),
  ),
  source: model.source,
  discoveredAt: model.discoveredAt.toISOString(),
  lastVerifiedAt: toTimestamp(model.lastVerifiedAt),
  createdByActorId: model.createdByActorId,
  updatedByActorId: model.updatedByActorId,
  approvedByActorId: model.approvedByActorId ?? undefined,
  approvedAt: toTimestamp(model.approvedAt),
  createdAt: model.createdAt.toISOString(),
  updatedAt: model.updatedAt.toISOString(),
})

const mapRoutingProfileRecord = (profile: {
  approvedAt: Date | null
  approvedByActorId: string | null
  createdAt: Date
  createdByActorId: string
  enabled: boolean
  exposure: 'admin_only' | 'standard'
  id: string
  label: string
  lifecycleStatus: 'approved' | 'deprecated' | 'draft'
  mode: 'committee' | 'fallback' | 'pipeline' | 'shadow' | 'single'
  organizationId: string
  routeGraph: unknown
  streamPolicy: 'buffered_judge' | 'primary_only'
  toolMediatorProfileId: string | null
  updatedAt: Date
  updatedByActorId: string
}): InferenceRoutingProfileRecord => ({
  id: profile.id,
  organizationId: parseOrganizationId(profile.organizationId),
  label: profile.label,
  enabled: profile.enabled,
  exposure:
    profile.exposure === 'admin_only' ? 'admin-only' : profile.exposure,
  lifecycleStatus: profile.lifecycleStatus,
  mode: profile.mode,
  streamPolicy: toContractStreamPolicy(profile.streamPolicy),
  toolMediatorProfileId: profile.toolMediatorProfileId ?? undefined,
  routeGraph: RouteGraphSchema.parse(toJsonRecord(profile.routeGraph)),
  createdByActorId: profile.createdByActorId,
  updatedByActorId: profile.updatedByActorId,
  approvedByActorId: profile.approvedByActorId ?? undefined,
  approvedAt: toTimestamp(profile.approvedAt),
  createdAt: profile.createdAt.toISOString(),
  updatedAt: profile.updatedAt.toISOString(),
})

const ensureProvider = async (
  prisma: PrismaClient,
  organizationId: string,
  providerId: string,
): Promise<{ id: string; providerKey: string; connectorKind: 'compiled' | 'openai_compatible' } | null> =>
  prisma.inferenceProvider.findFirst({
    where: {
      id: providerId,
      organizationId,
    },
    select: {
      id: true,
      providerKey: true,
      connectorKind: true,
    },
  })

const ensureCredentialBinding = async (
  prisma: PrismaClient,
  organizationId: string,
  bindingId: string,
) =>
  prisma.inferenceCredentialBinding.findFirst({
    where: {
      id: bindingId,
      organizationId,
    },
  })

const validateRouteGraph = (
  input: {
    mode: InferenceRoutingMode
    routeGraph: RouteGraph
  },
): void => {
  const graph = RouteGraphSchema.parse(input.routeGraph)
  const stageIds = new Set<string>()
  let visibleStages = 0
  let shadowStages = 0
  let advisorRoots = 0

  for (const stage of graph.stages) {
    if (stageIds.has(stage.id)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_DUPLICATE_STAGE_ID')
    }
    stageIds.add(stage.id)

    if (stage.userVisible === true) {
      visibleStages += 1
    }
    if (stage.role === 'shadow') {
      shadowStages += 1
    }
    if (stage.role === 'advisor' && !stage.inputFrom) {
      advisorRoots += 1
    }
  }

  if (visibleStages !== 1) {
    throw new Error('INFERENCE_ROUTING_PROFILE_REQUIRES_ONE_VISIBLE_STAGE')
  }

  if (input.mode === 'single' || input.mode === 'fallback') {
    if (graph.stages.some((stage) => stage.role !== 'executor')) {
      throw new Error('INFERENCE_ROUTING_PROFILE_INVALID_EXECUTOR_ONLY_GRAPH')
    }
    if (graph.stages.some((stage) => stage.inputFrom && stage.inputFrom.length > 0)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_INPUT_FROM_NOT_ALLOWED')
    }
  }

  if (input.mode === 'committee') {
    if (graph.stages.filter((stage) => stage.role === 'advisor').length < 2) {
      throw new Error('INFERENCE_ROUTING_PROFILE_COMMITTEE_NEEDS_ADVISORS')
    }
    if (advisorRoots !== graph.stages.filter((stage) => stage.role === 'advisor').length) {
      throw new Error('INFERENCE_ROUTING_PROFILE_COMMITTEE_ADVISORS_MUST_BE_ROOTS')
    }
    const terminal = graph.stages.find((stage) => stage.userVisible === true)
    if (!terminal || !['executor', 'synthesizer'].includes(terminal.role)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_COMMITTEE_TERMINAL_INVALID')
    }
  }

  if (input.mode === 'shadow') {
    const nonShadowVisible = graph.stages.filter(
      (stage) => stage.userVisible === true && stage.role !== 'shadow',
    )
    if (nonShadowVisible.length !== 1 || shadowStages < 1) {
      throw new Error('INFERENCE_ROUTING_PROFILE_SHADOW_INVALID')
    }
  }

  const adjacency = new Map<string, string[]>()
  for (const stage of graph.stages) {
    adjacency.set(stage.id, stage.inputFrom ?? [])
  }

  for (const stage of graph.stages) {
    for (const parentId of adjacency.get(stage.id) ?? []) {
      if (!stageIds.has(parentId)) {
        throw new Error('INFERENCE_ROUTING_PROFILE_MISSING_STAGE_REFERENCE')
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stageId: string) => {
    if (visited.has(stageId)) {
      return
    }
    if (visiting.has(stageId)) {
      throw new Error('INFERENCE_ROUTING_PROFILE_CYCLE_DETECTED')
    }
    visiting.add(stageId)
    for (const parentId of adjacency.get(stageId) ?? []) {
      visit(parentId)
    }
    visiting.delete(stageId)
    visited.add(stageId)
  }
  for (const stage of graph.stages) {
    visit(stage.id)
  }
}

const resetApproval = (actorId: string) => ({
  lifecycleStatus: 'draft' as const,
  approvedByActorId: null,
  approvedAt: null,
  updatedByActorId: actorId,
})

const approveMutation = (actorId: string) => ({
  lifecycleStatus: 'approved' as const,
  approvedByActorId: actorId,
  approvedAt: new Date(),
  updatedByActorId: actorId,
})

// ─── Providers ────────────────────────────────────────────────────────────

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
    data: approveMutation(actorContext.actor.actorId),
  })

  return mapProviderRecord(updated)
}

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

// ─── Credential bindings ──────────────────────────────────────────────────

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

// ─── Models ──────────────────────────────────────────────────────────────

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

  const updated = await prisma.inferenceModel.update({
    where: { id: model.id },
    data: approveMutation(actorContext.actor.actorId),
  })

  return mapModelRecord(updated)
}

// ─── Routing profiles ─────────────────────────────────────────────────────

export const listInferenceRoutingProfiles = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<InferenceRoutingProfileRecord[]> => {
  const profiles = await prisma.inferenceRoutingProfile.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
  })
  return profiles.map(mapRoutingProfileRecord)
}

export const getInferenceRoutingProfile = async (
  prisma: PrismaClient,
  organizationId: string,
  routingProfileId: string,
): Promise<InferenceRoutingProfileRecord | null> => {
  const profile = await prisma.inferenceRoutingProfile.findFirst({
    where: { id: routingProfileId, organizationId },
  })
  return profile ? mapRoutingProfileRecord(profile) : null
}

export const createInferenceRoutingProfile = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInferenceRoutingProfileBody,
): Promise<InferenceRoutingProfileRecord> => {
  validateRouteGraph({
    mode: input.mode,
    routeGraph: input.routeGraph,
  })

  const profile = await prisma.inferenceRoutingProfile.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      label: input.label,
      enabled: input.enabled ?? false,
      exposure:
        input.exposure === 'admin-only' ? 'admin_only' : input.exposure ?? 'standard',
      lifecycleStatus: 'draft',
      mode: input.mode,
      streamPolicy: toDbStreamPolicy(input.streamPolicy),
      toolMediatorProfileId: input.toolMediatorProfileId ?? null,
      routeGraph: asJsonValue(input.routeGraph),
      createdByActorId: actorContext.actor.actorId,
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapRoutingProfileRecord(profile)
}

export const updateInferenceRoutingProfile = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  routingProfileId: string,
  input: UpdateInferenceRoutingProfileBody,
): Promise<InferenceRoutingProfileRecord | null> => {
  const profile = await prisma.inferenceRoutingProfile.findFirst({
    where: {
      id: routingProfileId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!profile) {
    return null
  }

  const nextRouteGraph = input.routeGraph
    ? RouteGraphSchema.parse(input.routeGraph)
    : undefined

  if (nextRouteGraph || input.mode || input.toolMediatorProfileId !== undefined) {
    validateRouteGraph({
      mode: input.mode ?? profile.mode,
      routeGraph: nextRouteGraph ?? RouteGraphSchema.parse(toJsonRecord(profile.routeGraph)),
    })
  }

  const currentStreamPolicy =
    profile.streamPolicy === 'buffered_judge' ? 'buffered-judge' : 'primary-only'

  const materialChanged =
    (nextRouteGraph !== undefined && !sameJson(nextRouteGraph, profile.routeGraph)) ||
    (input.mode !== undefined && input.mode !== profile.mode) ||
    (input.toolMediatorProfileId !== undefined &&
      input.toolMediatorProfileId !== profile.toolMediatorProfileId) ||
    (input.exposure !== undefined &&
      input.exposure !== (profile.exposure === 'admin_only' ? 'admin-only' : 'standard')) ||
    (input.streamPolicy !== undefined && input.streamPolicy !== currentStreamPolicy)

  const updated = await prisma.inferenceRoutingProfile.update({
    where: { id: profile.id },
    data: {
      label: input.label ?? profile.label,
      enabled: input.enabled ?? profile.enabled,
      exposure:
        input.exposure === 'admin-only'
          ? 'admin_only'
          : input.exposure ?? profile.exposure,
      mode: input.mode ?? profile.mode,
      streamPolicy:
        input.streamPolicy === undefined
          ? profile.streamPolicy
          : toDbStreamPolicy(input.streamPolicy),
      toolMediatorProfileId:
        input.toolMediatorProfileId === undefined
          ? profile.toolMediatorProfileId
          : input.toolMediatorProfileId,
      routeGraph:
        nextRouteGraph !== undefined
          ? asJsonValue(nextRouteGraph)
          : asJsonValue(profile.routeGraph),
      ...(materialChanged ? resetApproval(actorContext.actor.actorId) : {}),
      updatedByActorId: actorContext.actor.actorId,
    },
  })

  return mapRoutingProfileRecord(updated)
}

export const approveInferenceRoutingProfile = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  routingProfileId: string,
): Promise<InferenceRoutingProfileRecord | null> => {
  const profile = await prisma.inferenceRoutingProfile.findFirst({
    where: {
      id: routingProfileId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!profile) {
    return null
  }

  const updated = await prisma.inferenceRoutingProfile.update({
    where: { id: profile.id },
    data: approveMutation(actorContext.actor.actorId),
  })

  return mapRoutingProfileRecord(updated)
}
