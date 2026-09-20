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

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const executorMachineKey = (encoded: string): crypto.KeyObject | null => {
  try {
    const key = Buffer.from(encoded, 'base64url')
    if (key.byteLength !== 32) return null
    return crypto.createPublicKey({
      format: 'der',
      key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
      type: 'spki',
    })
  } catch {
    return null
  }
}

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
    editorUoaIdentity?: { subject: string; tokenVersion: number | null }
    editorUserId: string
    manifestDigest: string
    modelName: string
    organizationId: string
    hostId: string
  },
): Promise<{ bindingId: string; challengeId: string; expiresAt: Date }> => {
  return prisma.$transaction(async (tx) => {
    await policyLock(tx, input.organizationId)
    const [agent, host, editor] = await Promise.all([
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
      tx.user.findUnique({
        where: { id: input.editorUserId },
        select: { id: true, tokenVersion: true, uoaSub: true },
      }),
    ])
    if (!agent || !host || !editor) {
      throw new LocalInferenceBindingError('NOT_FOUND', 'Agent or local host not found.')
    }
    if (
      input.editorUoaIdentity
      && (
        editor.uoaSub !== input.editorUoaIdentity.subject
        || input.editorUoaIdentity.tokenVersion === null
      )
    ) {
      throw new LocalInferenceBindingError('ENTITLEMENT_UNAVAILABLE',
        'The editor identity could not be verified for local inference.')
    }
    const editorUoaLink = input.editorUoaIdentity
      ? await tx.productAccountLink.findUnique({
        where: {
          organizationId_userId_productSlug: {
            organizationId: input.organizationId,
            productSlug: 'nessie',
            userId: input.editorUserId,
          },
        },
        select: { status: true, uoaSub: true, uoaTokenVersion: true },
      })
      : null
    if (
      input.editorUoaIdentity
      && (
        editorUoaLink?.status !== 'linked'
        || editorUoaLink.uoaSub !== input.editorUoaIdentity.subject
        || editorUoaLink.uoaTokenVersion !== input.editorUoaIdentity.tokenVersion
      )
    ) {
      throw new LocalInferenceBindingError('ENTITLEMENT_UNAVAILABLE',
        'The editor identity could not be verified for local inference.')
    }
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
        hostAuthorizationRevision: host.authorizationRevision,
        hostConnectionEpoch: host.connectionEpoch,
        hostId: host.id,
        manifestDigest: model.manifestDigest,
        modelName: model.name,
        numCtx: Math.min(8_192, model.numCtxCap ?? 8_192),
        organizationId: input.organizationId,
        preparedEditorTokenVersion: editor.tokenVersion,
        preparedEditorUoaSubject: input.editorUoaIdentity?.subject ?? null,
        preparedEditorUoaTokenVersion: input.editorUoaIdentity?.tokenVersion ?? null,
        preparedEditorUserId: editor.id,
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
  input: { agentId?: string; challengeId: string; hostId?: string; signature: string },
): Promise<{ bindingId: string }> => prisma.$transaction(async (tx) => {
  const challenge = await tx.localInferenceChallenge.findFirst({
    where: { id: input.challengeId, expiresAt: { gt: new Date() }, purpose: 'binding' },
    select: { bindingId: true, consumedAt: true, hostId: true, id: true },
  })
  if (!challenge || !challenge.bindingId) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The local consent request is no longer valid.')
  }
  const [binding, host] = await Promise.all([
    tx.agentLocalInferenceBinding.findUnique({
      where: { id: challenge.bindingId },
      select: {
        agentId: true, hostAuthorizationRevision: true, hostConnectionEpoch: true, hostId: true,
        id: true, preparedEditorTokenVersion: true, preparedEditorUoaSubject: true,
        preparedEditorUoaTokenVersion: true, preparedEditorUserId: true, status: true,
      },
    }),
    tx.localInferenceHost.findUnique({
      where: { id: challenge.hostId },
      select: {
        authorizationRevision: true, connectionEpoch: true, custodianUserId: true,
        executorId: true, organizationId: true, publicKey: true, revokedAt: true,
        transport: true,
      },
    }),
  ])
  if (
    !binding || !host || (input.hostId !== undefined && binding.hostId !== input.hostId)
    || (input.agentId !== undefined && binding.agentId !== input.agentId)
    || host.revokedAt
    || binding.hostAuthorizationRevision === null
    || binding.hostConnectionEpoch === null
    || binding.preparedEditorTokenVersion === null
    || !binding.preparedEditorUserId
    || binding.hostAuthorizationRevision !== host.authorizationRevision
    || binding.hostConnectionEpoch !== host.connectionEpoch
  ) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The selected local host is no longer available.')
  }
  const [agent, editor, memberships] = await Promise.all([
    tx.agent.findFirst({
      where: {
        id: binding.agentId,
        organizationId: host.organizationId,
        deletedAt: null,
      },
      select: { id: true, ownerUserId: true, systemManaged: true },
    }),
    tx.user.findUnique({
      where: { id: binding.preparedEditorUserId },
      select: { id: true, tokenVersion: true },
    }),
    tx.organizationMember.findMany({
      where: {
        deactivatedAt: null,
        organizationId: host.organizationId,
        userId: { in: [binding.preparedEditorUserId, host.custodianUserId] },
      },
      select: { userId: true },
    }),
  ])
  if (
    !agent || agent.systemManaged || agent.ownerUserId !== host.custodianUserId
    || !editor || editor.tokenVersion !== binding.preparedEditorTokenVersion
    || memberships.length !== new Set([binding.preparedEditorUserId, host.custodianUserId]).size
  ) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The local consent request is no longer valid.')
  }
  if (binding.preparedEditorUoaSubject !== null || binding.preparedEditorUoaTokenVersion !== null) {
    const link = binding.preparedEditorUoaSubject && binding.preparedEditorUoaTokenVersion !== null
      ? await tx.productAccountLink.findUnique({
        where: {
          organizationId_userId_productSlug: {
            organizationId: host.organizationId,
            productSlug: 'nessie',
            userId: binding.preparedEditorUserId,
          },
        },
        select: { status: true, uoaSub: true, uoaTokenVersion: true },
      })
      : null
    if (
      link?.status !== 'linked'
      || link.uoaSub !== binding.preparedEditorUoaSubject
      || link.uoaTokenVersion !== binding.preparedEditorUoaTokenVersion
    ) {
      throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The local consent request is no longer valid.')
    }
  }
  const [editorEntitlement, ownerEntitlement] = await Promise.all([
    resolveLiveEntitlementDecision(tx, {
      allowStoredIdentity: true,
      organizationId: host.organizationId,
      userId: binding.preparedEditorUserId,
    }),
    binding.preparedEditorUserId === host.custodianUserId
      ? null
      : resolveLiveEntitlementDecision(tx, {
        allowStoredIdentity: true,
        organizationId: host.organizationId,
        userId: host.custodianUserId,
      }),
  ])
  if (editorEntitlement.status !== 'allowed' || ownerEntitlement?.status !== 'allowed') {
    throw new LocalInferenceBindingError(
      editorEntitlement.status === 'unavailable' || ownerEntitlement?.status === 'unavailable'
        ? 'ENTITLEMENT_UNAVAILABLE'
        : 'CHALLENGE_INVALID',
      'The local consent request is no longer valid.',
    )
  }
  const publicKey = host.transport === 'desktop'
    ? (host.executorId === null ? host.publicKey : null)
    : host.transport === 'executor' && host.publicKey === null && host.executorId !== null
      ? await tx.executor.findFirst({
        where: {
          id: host.executorId,
          machinePublicKey: { not: null },
          organizationId: host.organizationId,
          pairingOwnerUserId: host.custodianUserId,
          status: 'online',
        },
        select: { machinePublicKey: true },
      }).then((executor) => executor?.machinePublicKey
        ? executorMachineKey(executor.machinePublicKey)
        : null)
      : null
  if (!publicKey) {
    throw new LocalInferenceBindingError('CHALLENGE_INVALID', 'The selected local host is no longer available.')
  }
  const signature = Buffer.from(input.signature, 'base64url')
  const valid = crypto.verify(
    null,
    signedConsentPayload(challenge.id, binding.id, binding.hostId),
    publicKey,
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
      data: {
        consentDigest: digest(input.signature),
        consentedAt: new Date(),
        consentedByUserId: host.custodianUserId,
        status: 'consented_pending_activation',
      },
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
