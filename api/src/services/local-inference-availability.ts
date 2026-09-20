import type { PrismaClient } from '@prisma/client'
import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  resolveLiveEntitlementDecision,
  resolveScopedSetting,
} from '@nessie/runtime'
import { ObservedLocalModelSchema, type AgentAvailabilityProjection } from '@nessie/schemas'

const projection = (
  availability: AgentAvailabilityProjection['availability'],
  reason: AgentAvailabilityProjection['reason'],
  revision: number,
  now: Date,
): AgentAvailabilityProjection => ({
  availability,
  reason,
  revision,
  serverTime: now.toISOString(),
  validUntil: new Date(now.getTime() + 60_000).toISOString(),
})

/** Reader-first, host-private availability projection. */
export const projectAgentLocalInferenceAvailability = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string },
): Promise<AgentAvailabilityProjection> => {
  const now = new Date()
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId, deletedAt: null },
    select: { localInferenceBindingId: true, ownerUserId: true, provider: true },
  })
  if (!agent?.localInferenceBindingId || agent.provider !== 'local/ollama') {
    return projection('offline', 'unconfigured', 0, now)
  }
  const binding = await prisma.agentLocalInferenceBinding.findFirst({
    where: { id: agent.localInferenceBindingId, organizationId: input.organizationId },
    select: {
      healthRevision: true, hostId: true, manifestDigest: true, modelName: true, status: true,
    },
  })
  if (!binding) return projection('offline', 'needs_reauthorization', 0, now)
  const host = await prisma.localInferenceHost.findFirst({
    where: { id: binding.hostId, organizationId: input.organizationId },
    select: { inventory: true, lastSeenAt: true, pausedAt: true, revokedAt: true },
  })
  if (!host) return projection('offline', 'needs_reauthorization', binding.healthRevision, now)
  if (binding.status === 'needs_rebinding') return projection('offline', 'needs_reauthorization', binding.healthRevision, now)
  if (binding.status === 'revoked' || host.revokedAt) return projection('offline', 'revoked', binding.healthRevision, now)
  if (binding.status !== 'active') return projection('offline', 'pending_consent', binding.healthRevision, now)
  if (host.pausedAt) return projection('offline', 'paused', binding.healthRevision, now)
  if (!host.lastSeenAt || host.lastSeenAt.getTime() + 60_000 <= now.getTime()) {
    return projection('offline', 'offline', binding.healthRevision, now)
  }
  const ownerUserId = agent.ownerUserId ?? null
  if (!ownerUserId) return projection('offline', 'needs_reauthorization', binding.healthRevision, now)
  const entitlement = await resolveLiveEntitlementDecision(prisma, {
    allowStoredIdentity: true, organizationId: input.organizationId, userId: ownerUserId,
  })
  if (entitlement.status === 'unavailable') return projection('unknown', 'entitlement_unavailable', binding.healthRevision, now)
  if (entitlement.status === 'denied') return projection('offline', 'policy_denied', binding.healthRevision, now)
  const setting = await resolveScopedSetting<boolean>(prisma, {
    organizationId: input.organizationId, userId: ownerUserId,
  }, LOCAL_INFERENCE_ENABLED_SETTING_KEY)
  if (setting.value !== true) return projection('offline', 'policy_denied', binding.healthRevision, now)
  const models = ObservedLocalModelSchema.array().safeParse(host.inventory)
  const match = models.success && models.data.some((model) =>
    model.name === binding.modelName
    && model.manifestDigest === binding.manifestDigest
    && model.remoteHost === null
    && model.remoteModel === null,
  )
  return match
    ? projection('online', 'ready', binding.healthRevision, now)
    : projection('offline', 'model_changed', binding.healthRevision, now)
}
