import type { Prisma } from '@prisma/client'
import { ObservedLocalModelSchema } from '@nessie/schemas'
import {
  LOCAL_INFERENCE_ENABLED_SETTING_KEY,
  resolveLiveEntitlementDecision,
  resolveScopedSetting,
} from '@nessie/runtime'

import {
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
} from './agent-create.js'
import type { AgentEditActor } from './agent-edit-authority.js'

const localModelIsStillEligible = (
  inventory: unknown,
  modelName: string,
  manifestDigest: string,
): boolean => {
  const models = ObservedLocalModelSchema.array().safeParse(inventory)
  return models.success && models.data.some((model) =>
    model.name === modelName
    && model.manifestDigest === manifestDigest
    && model.remoteHost === null
    && model.remoteModel === null
    && model.capabilities.length > 0,
  )
}

/**
 * The Designer's one activation commit.  Preparation, native consent and Save
 * each have different authority; this routine keeps the final compare-and-swap
 * beside the reusable agent writer instead of leaving an API-only back door.
 */
export const activateConsentedLocalInferenceBinding = async (
  tx: Prisma.TransactionClient,
  input: {
    actor: AgentEditActor
    agent: {
      id: string
      ownerUserId: string | null
      systemManaged: boolean
      updatedAt: Date
    }
    bindingId: string
    organizationId: string
  },
): Promise<{ id: string; modelName: string }> => {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`local-inference-policy:${input.organizationId}`}::text, 0)
    )
  `
  const binding = await tx.agentLocalInferenceBinding.findFirst({
    where: {
      agentId: input.agent.id,
      id: input.bindingId,
      organizationId: input.organizationId,
      status: 'consented_pending_activation',
    },
    select: {
      agentEditRevision: true,
      hostAuthorizationRevision: true,
      hostConnectionEpoch: true,
      hostId: true,
      id: true,
      manifestDigest: true,
      modelName: true,
      policyVersion: true,
      preparedEditorTokenVersion: true,
      preparedEditorUoaSubject: true,
      preparedEditorUoaTokenVersion: true,
      preparedEditorUserId: true,
    },
  })
  if (
    !binding || !binding.preparedEditorUserId
    || binding.preparedEditorTokenVersion === null
    || binding.hostAuthorizationRevision === null
    || binding.hostConnectionEpoch === null
    || binding.preparedEditorUserId !== input.actor.userId
  ) {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.LOCAL_BINDING_CONFLICT,
      'The local consent, model, or policy changed before this form was saved.',
    )
  }

  const [host, policy, editor] = await Promise.all([
    tx.localInferenceHost.findFirst({
      where: {
        id: binding.hostId,
        organizationId: input.organizationId,
        pausedAt: null,
        revokedAt: null,
      },
      select: {
        authorizationRevision: true,
        connectionEpoch: true,
        custodianUserId: true,
        inventory: true,
      },
    }),
    tx.localInferencePolicyVersion.upsert({
      where: { organizationId: input.organizationId },
      create: { organizationId: input.organizationId },
      update: {},
      select: { version: true },
    }),
    tx.user.findUnique({
      where: { id: input.actor.userId },
      select: { tokenVersion: true },
    }),
  ])
  const uoaIdentityMatches = binding.preparedEditorUoaSubject === null
    && binding.preparedEditorUoaTokenVersion === null
    ? input.actor.uoaIdentity === undefined
    : input.actor.uoaIdentity?.subject === binding.preparedEditorUoaSubject
      && input.actor.uoaIdentity.tokenVersion === binding.preparedEditorUoaTokenVersion
  const uoaLink = binding.preparedEditorUoaSubject !== null
    && binding.preparedEditorUoaTokenVersion !== null
    ? await tx.productAccountLink.findUnique({
      where: {
        organizationId_userId_productSlug: {
          organizationId: input.organizationId,
          productSlug: 'nessie',
          userId: input.actor.userId,
        },
      },
      select: { status: true, uoaSub: true, uoaTokenVersion: true },
    })
    : null
  const setting = input.agent.ownerUserId
    ? await resolveScopedSetting<boolean>(tx, {
      organizationId: input.organizationId,
      userId: input.agent.ownerUserId,
    }, LOCAL_INFERENCE_ENABLED_SETTING_KEY)
    : null
  const entitlement = input.agent.ownerUserId
    ? await resolveLiveEntitlementDecision(tx, {
      allowStoredIdentity: true,
      organizationId: input.organizationId,
      userId: input.agent.ownerUserId,
    })
    : { status: 'denied' as const }
  if (
    !host || !editor || editor.tokenVersion !== binding.preparedEditorTokenVersion
    || !uoaIdentityMatches
    || (binding.preparedEditorUoaSubject !== null && (
      uoaLink?.status !== 'linked'
      || uoaLink.uoaSub !== binding.preparedEditorUoaSubject
      || uoaLink.uoaTokenVersion !== binding.preparedEditorUoaTokenVersion
    ))
    || input.agent.systemManaged || !input.agent.ownerUserId
    || input.agent.ownerUserId !== host.custodianUserId
    || input.agent.updatedAt.getTime() !== binding.agentEditRevision.getTime()
    || host.authorizationRevision !== binding.hostAuthorizationRevision
    || host.connectionEpoch !== binding.hostConnectionEpoch
    || policy.version !== binding.policyVersion
    || setting?.value !== true
    || entitlement.status !== 'allowed'
    || !localModelIsStillEligible(host.inventory, binding.modelName, binding.manifestDigest)
  ) {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.LOCAL_BINDING_CONFLICT,
      'The local consent, model, or policy changed before this form was saved.',
    )
  }

  await tx.agentLocalInferenceBinding.updateMany({
    where: { agentId: input.agent.id, status: 'active' },
    data: { reason: 'replaced', status: 'revoked' },
  })
  await tx.agentLocalInferenceBinding.update({
    where: { id: binding.id },
    data: { reason: null, status: 'active' },
  })
  return { id: binding.id, modelName: binding.modelName }
}
