import { Prisma, type PrismaClient as PrismaDbClient } from '@prisma/client'
import { assertSafeUrl, UrlSafetyError } from '@nessie/runtime'
import { parseOrganizationId } from '@nessie/schemas'
import { ModelCapabilitySnapshotSchema, RouteGraphSchema } from '../contracts/inference-core.js'
import type {
  InferenceCredentialBindingRecord,
  InferenceModelRecord,
  InferenceProviderRecord,
  InferenceRoutingProfileRecord,
} from '../contracts/inference-control-plane.js'
import {
  toJsonRecord,
} from './contract-helpers.js'

// The generated Prisma client lags the schema surface during local typechecking.
// We widen it here so the control-plane modules can compile against the current
// runtime client. Every inference-control-plane-* module shares this type.
export type PrismaClient = PrismaDbClient & Record<string, unknown>

/**
 * Reject a private/loopback/link-local/metadata provider base URL at write time.
 * The runtime path validates too, but a stored internal URL is a persisted SSRF
 * primitive: every later inference call re-aims at it, and the failure surfaces
 * far from the operator who typed it in.
 */
export const assertProviderBaseUrlSafe = async (baseUrl: string | null): Promise<void> => {
  if (!baseUrl) return
  try {
    await assertSafeUrl(baseUrl)
  } catch (error) {
    if (error instanceof UrlSafetyError) {
      throw new Error('INFERENCE_PROVIDER_BASE_URL_UNSAFE')
    }
    throw error
  }
}

export const asJsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

export const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

export const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

export const toDbStreamPolicy = (
  value: 'primary-only' | 'buffered-judge' | undefined,
): 'primary_only' | 'buffered_judge' =>
  value === 'buffered-judge' ? 'buffered_judge' : 'primary_only'

export const toContractStreamPolicy = (
  value: 'primary_only' | 'buffered_judge',
): 'primary-only' | 'buffered-judge' =>
  value === 'buffered_judge' ? 'buffered-judge' : 'primary-only'

export const mapProviderRecord = (provider: {
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

export const mapCredentialBindingRecord = (binding: {
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

export const mapModelRecord = (model: {
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

export const mapRoutingProfileRecord = (profile: {
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

export const ensureProvider = async (
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

export const ensureCredentialBinding = async (
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

export const resetApproval = (actorId: string) => ({
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

/**
 * Shared shape of the three `approve*` entry points (providers, models,
 * routing profiles): look the row up scoped to the tenant, flip it to
 * `approved` with the actor stamped on, and map the result back to its
 * contract record. Each domain module supplies its own Prisma delegate and
 * mapper; the lifecycle transition itself lives here once.
 */
export const approveInferenceEntity = async <TRow, TRecord>(
  delegate: {
    findFirst: (args: { where: { id: string; organizationId: string } }) => Promise<TRow | null>
    update: (args: {
      where: { id: string }
      data: ReturnType<typeof approveMutation>
    }) => Promise<TRow>
  },
  organizationId: string,
  entityId: string,
  actorId: string,
  mapRecord: (row: TRow) => TRecord,
): Promise<TRecord | null> => {
  const existing = await delegate.findFirst({
    where: { id: entityId, organizationId },
  })
  if (!existing) {
    return null
  }

  const updated = await delegate.update({
    where: { id: entityId },
    data: approveMutation(actorId),
  })

  return mapRecord(updated)
}
