import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  resolveLiveEntitlementDecision,
  resolveScopedSetting,
} from '@nessie/runtime'
import { ObservedLocalModelSchema } from '@nessie/schemas'
import { LOCAL_INFERENCE_ENABLED_SETTING_KEY } from '@nessie/runtime'

export class LocalInferenceBindingError extends Error {
  override readonly name = 'LocalInferenceBindingError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

type Transaction = Parameters<PrismaClient['$transaction']>[0] extends (
  arg: infer Value,
) => unknown ? Value : never

const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

const policyLock = async (tx: Transaction, organizationId: string): Promise<void> => {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`local-inference-policy:${organizationId}`}::text, 0)
    )
  `
}

const policyVersion = async (tx: Transaction, organizationId: string): Promise<number> => {
  const row = await tx.localInferencePolicyVersion.upsert({
    where: { organizationId },
    create: { organizationId, version: 0 },
    update: {},
    select: { version: true },
  })
  return row.version
}

const selectedObservedModel = (inventory: unknown, modelName: string, manifestDigest: string) => {
  const parsed = ObservedLocalModelSchema.array().safeParse(inventory)
  if (!parsed.success) return null
  return parsed.data.find((model) =>
    model.name === modelName
    && model.manifestDigest === manifestDigest
    && model.remoteHost === null
    && model.remoteModel === null
    && model.capabilities.length > 0,
  ) ?? null
}

/**
 * Creates only an inactive exact binding.  Native confirmation and Designer
 * Save are intentionally separate: this function can never change an agent
 * lane, so a web request cannot mint local-machine consent by itself.
 */
export const prepareLocalInferenceBinding = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    editorUserId: string
    manifestDigest: string
    modelName: string
    organizationId: string
    hostId: string
  },
): Promise<{ bindingId: string; challengeId: string; expiresAt: Date }> => {
  return prisma.$transaction(async (tx) => {
    await policyLock(tx, input.organizationId)
    const [agent, host] = await Promise.all([
      tx.agent.findFirst({
        where: { id: input.agentId, organizationId: input.organizationId, deletedAt: null },
        select: { id: true, ownerUserId: true, systemManaged: true, updatedAt: true },
      }),
      tx.localInferenceHost.findFirst({
        where: { id: input.hostId, organizationId: input.organizationId, revokedAt: null },
        select: {
          authorizationRevision: true, connectionEpoch: true, custodianUserId: true,
          id: true, inventory: true, pausedAt: true,
        },
      }),
    ])
    if (!agent || !host) throw new LocalInferenceBindingError('NOT_FOUND', 'Agent or local host not found.')
    if (agent.systemManaged || !agent.ownerUserId) {
      throw new LocalInferenceBindingError('OWNER_HOST_ONLY', 'Only a person-owned agent can use a local host.')
    }
    if (agent.ownerUserId !== host.custodianUserId) {
      throw new LocalInferenceBindingError('OWNER_CUSTODIAN_MISMATCH',
        'A local host can only process its owner’s own agent.')
    }
    if (host.pausedAt) throw new LocalInferenceBindingError('HOST_PAUSED', 'This local host is paused.')
    const resolved = await resolveScopedSetting<boolean>(tx, {
      organizationId: input.organizationId,
      userId: agent.ownerUserId,
    }, LOCAL_INFERENCE_ENABLED_SETTING_KEY)
    if (resolved.value !== true) {
      throw new LocalInferenceBindingError('POLICY_DENIED', 'Local models are disabled for this work.')
    }
    const entitlement = await resolveLiveEntitlementDecision(tx, {
      allowStoredIdentity: true,
      organizationId: input.organizationId,
      userId: agent.ownerUserId,
    })
    if (entitlement.status === 'unavailable') {
      throw new LocalInferenceBindingError('ENTITLEMENT_UNAVAILABLE', 'Availability cannot be verified right now.')
    }
    if (entitlement.status === 'denied') {
      throw new LocalInferenceBindingError('POLICY_DENIED', 'Access to local inference has been removed.')
    }
    const model = selectedObservedModel(host.inventory, input.modelName, input.manifestDigest)
    if (!model) {
      throw new LocalInferenceBindingError('MODEL_NOT_LOCAL',
        'That model is not currently verified as local on the selected computer.')
    }
    const version = await policyVersion(tx, input.organizationId)
    const binding = await tx.agentLocalInferenceBinding.create({
      data: {
        agentEditRevision: agent.updatedAt,
        agentId: agent.id,
        capabilitySnapshot: {
          capabilities: model.capabilities,
          reportedAt: model.reportedAt,
        },
        hostId: host.id,
        manifestDigest: model.manifestDigest,
        modelName: model.name,
        numCtx: Math.min(8_192, model.numCtxCap ?? 8_192),
        organizationId: input.organizationId,
        policyVersion: version,
        reason: null,
        status: 'pending',
      },
      select: { id: true },
    })
    const challenge = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 5 * 60_000)
    const challengeRow = await tx.localInferenceChallenge.create({
      data: {
        bindingId: binding.id,
        digest: digest(challenge),
        expiresAt,
        hostId: host.id,
        organizationId: input.organizationId,
        subjectDigest: digest(`${input.editorUserId}:${host.authorizationRevision}`),
      },
      select: { id: true },
    })
    return { bindingId: binding.id, challengeId: challengeRow.id, expiresAt }
  })
}

const signedConsentPayload = (challengeId: string, bindingId: string, hostId: string): Buffer =>
  Buffer.from(`nessie-local-inference-consent-v1\n${challengeId}\n${bindingId}\n${hostId}`, 'utf8')

/**
 * Daemon confirmation is idempotent but remains inactive.  Only the Designer
 * Save transaction below can select this binding on Agent.
 */
export const confirmLocalInferenceBinding = async (
  prisma: PrismaClient,
  input: { challengeId: string; hostId: string; signature: string },
): Promise<{ bindingId: string }> => prisma.$transaction(async (tx) => {
  const challenge = await tx.localInferenceChallenge.findFirst({
    where: { id: input.challengeId, expiresAt: { gt: new Date() } },
    select: { bindingId: true, consumedAt: true, hostId: true, id: true },
  })
  if (!challenge || !challenge.bindingId || challenge.hostId !== input.hostId) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The local consent request is no longer valid.')
  }
  const [binding, host] = await Promise.all([
    tx.agentLocalInferenceBinding.findUnique({
      where: { id: challenge.bindingId },
      select: { hostId: true, id: true, status: true },
    }),
    tx.localInferenceHost.findUnique({
      where: { id: input.hostId },
      select: { publicKey: true, revokedAt: true },
    }),
  ])
  if (!binding || !host || binding.hostId !== input.hostId || host.revokedAt || !host.publicKey) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The selected local host is no longer available.')
  }
  const signature = Buffer.from(input.signature, 'base64url')
  const valid = crypto.verify(
    null,
    signedConsentPayload(challenge.id, binding.id, binding.hostId),
    host.publicKey,
    signature,
  )
  if (!valid) throw new LocalInferenceBindingError('SIGNATURE_INVALID', 'Local consent could not be verified.')
  // A lost server response may make the native bridge post the exact signed
  // consent again. It is idempotent only for this exact consumed challenge.
  if (challenge.consumedAt && binding.status === 'consented_pending_activation') {
    return { bindingId: binding.id }
  }
  if (challenge.consumedAt) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The local consent request is no longer valid.')
  }
  await tx.localInferenceChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })
  if (binding.status === 'pending') {
    await tx.agentLocalInferenceBinding.update({
      where: { id: binding.id },
      data: { consentedAt: new Date(), status: 'consented_pending_activation' },
    })
  }
  return { bindingId: binding.id }
})

/**
 * The sole activation commit.  It is intentionally called by the existing
 * Agent Designer Save write, never by confirmation, heartbeat, or a browser
 * host-management action.  Any stale form, policy, host epoch, owner or model
 * leaves the previous lane untouched.
 */
export const activateConsentedLocalInferenceBinding = async (
  prisma: PrismaClient,
  input: { agentId: string; bindingId: string; organizationId: string },
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await policyLock(tx, input.organizationId)
    const binding = await tx.agentLocalInferenceBinding.findFirst({
      where: { id: input.bindingId, organizationId: input.organizationId },
      select: {
        agentEditRevision: true, agentId: true, hostId: true, id: true,
        manifestDigest: true, modelName: true, policyVersion: true, status: true,
      },
    })
    if (!binding || binding.agentId !== input.agentId || binding.status !== 'consented_pending_activation') {
      throw new LocalInferenceBindingError('ACTIVATION_CONFLICT', 'This local consent is no longer ready to save.')
    }
    const [agent, host, version] = await Promise.all([
      tx.agent.findFirst({
        where: { id: input.agentId, organizationId: input.organizationId, deletedAt: null },
        select: { id: true, ownerUserId: true, routingProfileId: true, systemManaged: true, updatedAt: true },
      }),
      tx.localInferenceHost.findFirst({
        where: { id: binding.hostId, organizationId: input.organizationId, pausedAt: null, revokedAt: null },
        select: { connectionEpoch: true, custodianUserId: true, inventory: true },
      }),
      policyVersion(tx, input.organizationId),
    ])
    if (!agent || !host || agent.systemManaged || !agent.ownerUserId
      || agent.ownerUserId !== host.custodianUserId
      || agent.routingProfileId !== null
      || agent.updatedAt.getTime() !== binding.agentEditRevision.getTime()
      || version !== binding.policyVersion
      || !selectedObservedModel(host.inventory, binding.modelName, binding.manifestDigest)) {
      throw new LocalInferenceBindingError('ACTIVATION_CONFLICT',
        'The agent, local model, or policy changed before this consent was saved.')
    }
    const entitlement = await resolveLiveEntitlementDecision(tx, {
      allowStoredIdentity: true,
      organizationId: input.organizationId,
      userId: agent.ownerUserId,
    })
    if (entitlement.status !== 'allowed') {
      throw new LocalInferenceBindingError(
        entitlement.status === 'unavailable' ? 'ENTITLEMENT_UNAVAILABLE' : 'POLICY_DENIED',
        entitlement.status === 'unavailable'
          ? 'Availability cannot be verified right now.'
          : 'Access to local inference has been removed.',
      )
    }
    const resolved = await resolveScopedSetting<boolean>(tx, {
      organizationId: input.organizationId,
      userId: agent.ownerUserId,
    }, LOCAL_INFERENCE_ENABLED_SETTING_KEY)
    if (resolved.value !== true) {
      throw new LocalInferenceBindingError('POLICY_DENIED', 'Local models are disabled for this work.')
    }
    await tx.agentLocalInferenceBinding.updateMany({
      where: { agentId: agent.id, status: 'active' },
      data: { reason: 'replaced', status: 'revoked' },
    })
    await tx.agentLocalInferenceBinding.update({
      where: { id: binding.id },
      data: { reason: null, status: 'active' },
    })
    await tx.agent.update({
      where: { id: agent.id },
      data: {
        localInferenceBindingId: binding.id,
        model: binding.modelName,
        modelSubscriptionId: null,
        provider: 'local/ollama',
      },
    })
  })
}
