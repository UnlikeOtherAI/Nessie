import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  resolveLiveEntitlementDecision,
  resolveScopedSetting,
} from '@nessie/runtime'
import { ObservedLocalModelSchema } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
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

const selectedLocalModelIsFresh = (input: {
  inventory: unknown
  inventoryObservedAt: Date | null
  manifestDigest: string
  modelName: string
  now: Date
}): boolean => {
  if (!freshHost(input.inventoryObservedAt, input.now)) return false
  const models = ObservedLocalModelSchema.array().safeParse(input.inventory)
  return models.success && models.data.some((model) => (
    model.name === input.modelName
    && model.manifestDigest === input.manifestDigest
    && model.remoteHost === null
    && model.remoteModel === null
    && model.capabilities.includes('text')
  ))
}

/**
 * Resolves the explicit local-device lane at run admission. This deliberately
 * does not fall through to either Ledger or a subscription: a dangling pin is
 * a customer-visible repair state, not permission to move prompt bytes.
 */
const resolveLocalInferenceBinding = async (
  deps: ExecutionDependencies,
  context: RunContext,
  receiptOnly: boolean,
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
      revision: true,
    },
  })
  const ownerUserId = context.agent.ownerUserId ?? null
  const host = binding
    ? await deps.prisma.localInferenceHost.findFirst({
      where: { id: binding.hostId, organizationId: context.channel.organizationId },
      select: {
        connectionEpoch: true, custodianUserId: true, id: true, inventory: true,
        inventoryObservedAt: true, lastSeenAt: true,
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
  if (host.revokedAt || !receiptOnly && host.pausedAt) {
    return {
      kind: 'unavailable',
      reason: host.pausedAt
        ? 'The selected local host is paused'
        : 'The selected local host was revoked',
    }
  }
  if (!receiptOnly && !freshHost(host.lastSeenAt, new Date())) {
    return {
      kind: 'unavailable',
      reason: 'The selected local host is offline',
    }
  }
  if (!receiptOnly && !selectedLocalModelIsFresh({
    inventory: host.inventory,
    inventoryObservedAt: host.inventoryObservedAt,
    manifestDigest: binding.manifestDigest,
    modelName: binding.modelName,
    now: new Date(),
  })) {
    return {
      kind: 'unavailable',
      reason: 'The selected local model is no longer available',
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
      revision: binding.revision,
    },
    kind: 'local',
  }
}

export const resolveRunLocalInferenceBinding = (
  deps: ExecutionDependencies, context: RunContext,
): Promise<RunLocalInferenceResolution> => resolveLocalInferenceBinding(deps, context, false)

/** Known receipts need live authority, but do not send another byte to the host. */
export const resolveLocalInferenceReceiptBinding = (
  deps: ExecutionDependencies, context: RunContext,
): Promise<RunLocalInferenceResolution> => resolveLocalInferenceBinding(deps, context, true)

/**
 * Write the selected local lane to the Run before a budget or provider path is
 * allowed to continue.  A retry may repeat the exact pin, but a stale worker
 * can never replace it with a newly selected binding or host.  This is the
 * run-level counterpart to the durable Agent selection: spawned child agents
 * do not inherit a binding merely because one parent run happened to use it.
 */
export const persistRunLocalInferenceBinding = async (
  prisma: Pick<PrismaClient, 'run'>,
  input: { binding: RunLocalInferenceBinding; runId: string },
): Promise<void> => {
  const existingOrExactPin = {
    OR: [
      {
        localInferenceBindingId: null,
        localInferenceBindingRevision: null,
        localInferenceHostEpoch: null,
        localInferenceHostId: null,
        localInferenceModelDigest: null,
      },
      {
        localInferenceBindingId: input.binding.bindingId,
        localInferenceBindingRevision: input.binding.revision,
        localInferenceHostEpoch: input.binding.hostEpoch,
        localInferenceHostId: input.binding.hostId,
        localInferenceModelDigest: input.binding.manifestDigest,
      },
    ],
  }
  const updated = await prisma.run.updateMany({
    where: { id: input.runId, ...existingOrExactPin },
    data: {
      localInferenceBindingId: input.binding.bindingId,
      localInferenceBindingRevision: input.binding.revision,
      localInferenceHostEpoch: input.binding.hostEpoch,
      localInferenceHostId: input.binding.hostId,
      localInferenceModelDigest: input.binding.manifestDigest,
    },
  })
  if (updated.count !== 1) {
    throw new Error('Local inference run pin changed before admission completed.')
  }
}

export const localInferenceUnavailableNotice = (input: {
  isOwnerViewing: boolean
  reason: string
}): string => input.isOwnerViewing
  ? `${input.reason}. Repair it in Agent Designer → Model.`
  : `${input.reason}. Ask this agent’s owner to repair its local model connection.`
