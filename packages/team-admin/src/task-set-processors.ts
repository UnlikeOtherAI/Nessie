import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import type { LedgerIdentityService } from '@nessie/runtime'
import type {
  AuthorizedActionContext, TaskSetProcessor, TaskSetProcessorOption,
} from '@nessie/schemas'
import { listAgentModelOptionsForUser } from './agent-model-options.js'
import { assertAgentModelSelection } from './agent-model-selection.js'
import { ledgerAgentModelCatalogRequestHeaders } from './ledger-agent-model-catalog.js'
import { assertTaskSetActor, TaskSetError } from './task-set-access.js'

export type TaskSetModelDeps = {
  prisma: PrismaClient
  modelConfig: ModelConfig
  ledgerIdentity: LedgerIdentityService | null
}

export const listTaskSetProcessors = async (
  deps: TaskSetModelDeps, actor: AuthorizedActionContext,
): Promise<TaskSetProcessorOption[]> => {
  const { userId } = await assertTaskSetActor(deps.prisma, actor)
  const bindings = await deps.prisma.agentLocalInferenceBinding.findMany({
    where: { organizationId: actor.tenant.organizationId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  })
  const ownedAgents = await deps.prisma.agent.findMany({
    where: { organizationId: actor.tenant.organizationId, ownerUserId: userId, deletedAt: null },
    select: { id: true, localInferenceBindingId: true },
  })
  const local: TaskSetProcessorOption[] = []
  for (const binding of bindings) {
    if (!ownedAgents.some((agent) => agent.id === binding.agentId && agent.localInferenceBindingId === binding.id)) {
      continue
    }
    const host = await deps.prisma.localInferenceHost.findFirst({
      where: { id: binding.hostId, organizationId: actor.tenant.organizationId, custodianUserId: userId },
    })
    if (!host || host.revokedAt) continue
    const reason = host.pausedAt ? 'Local processor paused'
      : !host.lastSeenAt || host.lastSeenAt.getTime() < Date.now() - 60_000 ? 'Waiting for local processor' : null
    local.push({
      id: `local:${binding.id}`, label: `${binding.modelName} · ${host.displayLabel}`,
      provider: 'local/ollama', model: binding.modelName, localInferenceBindingId: binding.id,
      localInferenceHostId: host.id,
      ...(host.inferenceResourceId ? { inferenceResourceId: host.inferenceResourceId } : {}),
      source: 'local', resourceLabel: host.displayLabel, available: reason === null,
      reason, setupUrl: '/admin/computers',
    })
  }
  let hosted: TaskSetProcessorOption[] = []
  try {
    const result = await listAgentModelOptionsForUser(deps.prisma, {
      config: deps.modelConfig, organizationId: actor.tenant.organizationId, userId,
      teamId: actor.tenant.teamId,
      requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
        actorContext: actor, ledgerIdentity: deps.ledgerIdentity,
      }),
    })
    hosted = result.options.map((option) => ({
      id: `${option.provider}:${option.model}:${option.modelSubscriptionId ?? ''}`,
      label: `${option.displayName} · ${option.accountLabel ?? option.providerDisplayName}`,
      provider: option.provider, model: option.model,
      ...(option.modelSubscriptionId ? { modelSubscriptionId: option.modelSubscriptionId } : {}),
      source: option.source === 'subscription' ? 'subscription' as const : 'ledger' as const,
      resourceLabel: option.accountLabel ?? option.providerDisplayName,
      available: true, reason: null, setupUrl: null,
    }))
    if (result.ledgerError && hosted.length === 0 && local.length === 0) throw result.ledgerError
  } catch (error) { if (local.length === 0) throw error }
  return [...local, ...hosted]
}

export const resolveTaskSetProcessor = async (
  deps: TaskSetModelDeps, actor: AuthorizedActionContext, processor: TaskSetProcessor,
) => {
  const { userId } = await assertTaskSetActor(deps.prisma, actor)
  if (processor.provider === 'local/ollama') {
    if (!processor.localInferenceBindingId || processor.modelSubscriptionId) {
      throw new TaskSetError('TASK_SET_LOCAL_CONSENT', 'Select an already approved local model binding.')
    }
    const binding = await deps.prisma.agentLocalInferenceBinding.findFirst({ where: {
      id: processor.localInferenceBindingId, organizationId: actor.tenant.organizationId,
      status: 'active', modelName: processor.model,
    } })
    const agent = binding ? await deps.prisma.agent.findFirst({ where: {
      id: binding.agentId, ownerUserId: userId, deletedAt: null, localInferenceBindingId: binding.id,
    } }) : null
    const host = binding ? await deps.prisma.localInferenceHost.findFirst({ where: {
      id: binding.hostId, custodianUserId: userId, organizationId: actor.tenant.organizationId, revokedAt: null,
    } }) : null
    if (!binding || !agent || !host) {
      throw new TaskSetError('TASK_SET_LOCAL_CONSENT', 'Approve this exact local model in Agent Designer first.', 403)
    }
    return { agentId: agent.id, capacityKey: `local:${host.inferenceResourceId ?? host.id}`, pin: {
      kind: 'local', bindingId: binding.id, hostId: host.id,
      revision: binding.revision, manifestDigest: binding.manifestDigest, numCtx: binding.numCtx,
    } }
  }
  if (processor.localInferenceBindingId) throw new TaskSetError('TASK_SET_PROCESSOR', 'Invalid processor binding.')
  await assertAgentModelSelection(deps.prisma, {
    ...processor, actingUserId: userId, ownerUserId: userId,
    organizationId: actor.tenant.organizationId, teamId: actor.tenant.teamId,
    config: deps.modelConfig,
    requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
      actorContext: actor, ledgerIdentity: deps.ledgerIdentity,
    }),
  })
  const agent = await deps.prisma.agent.findFirst({ where: {
    organizationId: actor.tenant.organizationId, agentKind: 'personal_assistant', deletedAt: null,
  }, select: { id: true } })
  if (!agent) throw new TaskSetError('TASK_SET_SETUP', 'Open your personal assistant once to finish setup.')
  const subscription = processor.modelSubscriptionId ? await deps.prisma.modelSubscription.findUniqueOrThrow({
    where: { id: processor.modelSubscriptionId }, select: { id: true, credentialEpoch: true, provider: true },
  }) : null
  return {
    agentId: agent.id,
    pin: subscription ? {
      kind: 'subscription', subscriptionId: subscription.id, epoch: subscription.credentialEpoch,
      providerKey: subscription.provider, ownerUserId: userId,
    } : { kind: 'ledger', ...processor },
    capacityKey: processor.modelSubscriptionId ? `subscription:${processor.modelSubscriptionId}`
      : `ledger:${actor.tenant.organizationId}:${processor.provider}`,
  }
}
