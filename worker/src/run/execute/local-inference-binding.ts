import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  resolveLiveEntitlementDecision,
  resolveScopedSetting,
} from '@nessie/runtime'
import type { ExecutionDependencies, RunContext } from './types.js'

export type RunLocalInferenceBinding = {
  bindingId: string
  hostEpoch: number
  hostId: string
  manifestDigest: string
  modelName: string
  numCtx: number
  revision: number
}

export type RunLocalInferenceResolution =
  | { kind: 'not-local' }
  | { binding: RunLocalInferenceBinding; kind: 'local' }
  | { kind: 'unavailable'; reason: string }

const freshHost = (lastSeenAt: Date | null, now: Date): boolean =>
  lastSeenAt !== null && lastSeenAt.getTime() + 60_000 > now.getTime()

/**
 * Resolves the explicit local-device lane at run admission. This deliberately
 * does not fall through to either Ledger or a subscription: a dangling pin is
 * a customer-visible repair state, not permission to move prompt bytes.
 */
export const resolveRunLocalInferenceBinding = async (
  deps: ExecutionDependencies,
  context: RunContext,
): Promise<RunLocalInferenceResolution> => {
  const bindingId = context.agent.localInferenceBindingId ?? null
  if (!bindingId && context.agent.provider !== 'local/ollama') {
    return { kind: 'not-local' }
  }
  if (!bindingId) {
    return {
      kind: 'unavailable',
      reason: 'This agent’s local model connection needs to be selected again',
    }
  }
  const binding = await deps.prisma.agentLocalInferenceBinding.findFirst({
    where: {
      agentId: context.agent.id,
      id: bindingId,
      organizationId: context.channel.organizationId,
      status: 'active',
    },
    select: {
      hostId: true,
      id: true,
      manifestDigest: true,
      modelName: true,
      numCtx: true,
      policyVersion: true,
    },
  })
  const ownerUserId = context.agent.ownerUserId ?? null
  const host = binding
    ? await deps.prisma.localInferenceHost.findFirst({
      where: { id: binding.hostId, organizationId: context.channel.organizationId },
      select: {
        connectionEpoch: true, custodianUserId: true, id: true, lastSeenAt: true,
        pausedAt: true, revokedAt: true,
      },
    })
    : null
  if (!binding || !host || !ownerUserId || host.custodianUserId !== ownerUserId) {
    return {
      kind: 'unavailable',
      reason: 'This agent’s local model connection needs repair',
    }
  }
  if (host.revokedAt || host.pausedAt) {
    return {
      kind: 'unavailable',
      reason: host.pausedAt
        ? 'The selected local host is paused'
        : 'The selected local host was revoked',
    }
  }
  if (!freshHost(host.lastSeenAt, new Date())) {
    return {
      kind: 'unavailable',
      reason: 'The selected local host is offline',
    }
  }
  const [policy, entitlement, version] = await Promise.all([
    resolveScopedSetting<boolean>(deps.prisma, {
      organizationId: context.channel.organizationId,
      userId: ownerUserId,
    }, LOCAL_INFERENCE_ENABLED_SETTING_KEY),
    resolveLiveEntitlementDecision(deps.prisma, {
      allowStoredIdentity: true,
      organizationId: context.channel.organizationId,
      userId: ownerUserId,
    }),
    deps.prisma.localInferencePolicyVersion.findUnique({
      where: { organizationId: context.channel.organizationId },
      select: { version: true },
    }),
  ])
  if (entitlement.status === 'unavailable') {
    return { kind: 'unavailable', reason: 'Local access cannot be verified right now' }
  }
  if (entitlement.status === 'denied' || policy.value !== true) {
    return { kind: 'unavailable', reason: 'Local models are no longer enabled for this work' }
  }
  if ((version?.version ?? 0) !== binding.policyVersion) {
    return { kind: 'unavailable', reason: 'Local model policy changed; select the model again' }
  }
  return {
    binding: {
      bindingId: binding.id,
      hostEpoch: host.connectionEpoch,
      hostId: binding.hostId,
      manifestDigest: binding.manifestDigest,
      modelName: binding.modelName,
      numCtx: binding.numCtx,
      revision: binding.policyVersion,
    },
    kind: 'local',
  }
}

export const localInferenceUnavailableNotice = (input: {
  isOwnerViewing: boolean
  reason: string
}): string => input.isOwnerViewing
  ? `${input.reason}. Repair it in Agent Designer → Model.`
  : `${input.reason}. Ask this agent’s owner to repair its local model connection.`
