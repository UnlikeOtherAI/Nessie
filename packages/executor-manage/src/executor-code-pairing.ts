import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ExecutorPairingStartRequestSchema, ExecutorSignedDescriptorSchema,
  type ExecutorPairingStartRequest, type ExecutorPairingStartResponse,
  type ExecutorPairingPreview, type ExecutorPairingClaimRequest,
  type ExecutorPairingClaimResponse, type ExecutorPairingOptions,
} from '@nessie/schemas'
import { canonicalExecutorJson } from './executor-canonical-json.js'
import { ExecutorError, EXECUTOR_ERROR_CODES } from './executor-errors.js'
import {
  assertPairingProof, assertPairingTimestamp, lockPairing, pairingCode, pairingCodeVerifier,
  pairingDigest, pairingRequestDigest, pairingStartPayload, pairingUnavailable, revokePairingExecutor,
  type ExecutorPairingLeaseNotice,
} from './executor-code-proof.js'
import type { ExecutorLeaseRef } from './executor-conversation-lease.js'

export type PairingAudit = (tx: Prisma.TransactionClient, event: {
  action: 'executor.pairing.claimed' | 'executor.pairing.confirmed' | 'executor.pairing.rejected'
    | 'executor.pairing.replaced' | 'executor.pairing.expired'
  executorId: string; organizationId: string; userId: string
}) => Promise<void>

export const startExecutorCodePairing = async (
  prisma: PrismaClient, secret: string, input: ExecutorPairingStartRequest, audit: PairingAudit, now = new Date(),
  onLeasesEnded?: ExecutorPairingLeaseNotice,
): Promise<ExecutorPairingStartResponse> => {
  const parsed = ExecutorPairingStartRequestSchema.parse(input)
  assertPairingTimestamp(parsed.timestamp, now)
  const payload = pairingStartPayload(parsed)
  assertPairingProof(parsed.machinePublicKey, 'nessie.executor.pairing.start.v1', payload, parsed.signature)
  assertPairingProof(
    parsed.machinePublicKey, 'nessie.executor.descriptor.v1', parsed.descriptor.descriptor, parsed.descriptor.signature,
  )
  const fingerprint = pairingDigest(parsed.machinePublicKey)
  const requestDigest = pairingRequestDigest(parsed)
  // A machine pairing again revokes its previous executor row, and with it the
  // leases on it; their holders hear once the new pairing has committed.
  let endedLeases: ExecutorLeaseRef[] = []
  const started = await prisma.$transaction(async (tx): Promise<ExecutorPairingStartResponse> => {
    await lockPairing(tx, parsed.requestId)
    const existing = await tx.executorPairingCode.findUnique({ where: { id: parsed.requestId } })
    if (existing) {
      // A lost mint response must be recoverable even after expiry/cancel.
      // This only returns the old receipt; it never extends or reopens it.
      if (existing.requestDigest !== requestDigest) pairingUnavailable()
      return {
        pairingId: existing.id, code: pairingCode(secret, existing.id, existing.codeNonce),
        fingerprint, expiresAt: existing.expiresAt.toISOString(), pollIntervalSeconds: 3,
      }
    }
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`executor-key:${fingerprint}`}, 0))
    `)
    const paired = await tx.executor.findUnique({ where: { machineKeyFingerprint: fingerprint }, select: { id: true } })
    if (paired) pairingUnavailable()
    const pending = await tx.executorPairingCode.findFirst({ where: {
      fingerprint, expiresAt: { gt: now }, rejectedAt: null,
    } })
    if (pending) pairingUnavailable()
    // Allocate under one fleet-wide lock, so different machine keys cannot race
    // on the same eight digits. Persist the nonce, never the plaintext code.
    await lockPairing(tx, 'code-allocation')
    let codeNonce = 0
    let code = pairingCode(secret, parsed.requestId, codeNonce)
    while (await tx.executorPairingCode.findUnique({ where: { codeVerifier: pairingCodeVerifier(secret, code) } })) {
      codeNonce += 1
      code = pairingCode(secret, parsed.requestId, codeNonce)
    }
    if (parsed.replacesExecutorId) {
      const previous = await tx.executor.findUnique({ where: { id: parsed.replacesExecutorId } })
      if (!previous?.machinePublicKey || !parsed.replacementSignature) pairingUnavailable()
      assertPairingProof(
        previous.machinePublicKey, 'nessie.executor.pairing.replace.v1', payload, parsed.replacementSignature,
      )
      endedLeases = await revokePairingExecutor(tx, previous.id)
      await audit(tx, {
        action: 'executor.pairing.replaced', executorId: previous.id,
        organizationId: previous.organizationId, userId: previous.pairingOwnerUserId,
      })
    } else if (parsed.replacementSignature) pairingUnavailable()
    const expiresAt = new Date(now.getTime() + 600_000)
    await tx.executorPairingCode.create({ data: {
      id: parsed.requestId, codeVerifier: pairingCodeVerifier(secret, code), codeNonce, requestDigest,
      machinePublicKey: parsed.machinePublicKey, fingerprint, machineName: parsed.machineName,
      descriptor: parsed.descriptor as Prisma.InputJsonValue, expiresAt,
    } })
    return {
      pairingId: parsed.requestId, code, fingerprint, expiresAt: expiresAt.toISOString(), pollIntervalSeconds: 3,
    }
  })
  if (endedLeases.length > 0) await onLeasesEnded?.(endedLeases)
  return started
}

export const previewExecutorCodePairing = async (
  prisma: PrismaClient, secret: string, code: string, now = new Date(),
): Promise<ExecutorPairingPreview> => {
  const pairing = await prisma.executorPairingCode.findUnique({
    where: { codeVerifier: pairingCodeVerifier(secret, code) },
  })
  if (!pairing || pairing.expiresAt <= now || pairing.claimedAt || pairing.rejectedAt) pairingUnavailable()
  const descriptor = ExecutorSignedDescriptorSchema.parse(pairing.descriptor).descriptor
  return {
    pairingId: pairing.id, machineName: pairing.machineName, fingerprint: pairing.fingerprint,
    expiresAt: pairing.expiresAt.toISOString(), platformFacts: {
      platform: descriptor.platform, supervisor: descriptor.supervisor, sandboxBackend: descriptor.sandboxBackend,
    },
  }
}

export type PairingClaimAuthority = {
  userId: string; options: ExecutorPairingOptions; projectIds: string[]
}

export const claimExecutorCodePairing = async (
  prisma: PrismaClient, secret: string, input: ExecutorPairingClaimRequest,
  authority: PairingClaimAuthority, audit: PairingAudit, now = new Date(),
): Promise<ExecutorPairingClaimResponse> => {
  if (
    input.scope.organizationId !== authority.options.organization.id
    || !authority.options.scopes.includes(input.scope.kind)
    || (input.scope.kind === 'project' && !authority.projectIds.includes(input.scope.projectId))
    || (input.scope.kind === 'project' && !authority.options.teams.some((team) =>
      team.id === input.teamId && team.projectIds.includes(input.scope.kind === 'project' ? input.scope.projectId : '')))
    || (input.teamId !== null && !authority.options.teams.some((team) => team.id === input.teamId))
    || (input.teamId === null && authority.options.teams.length > 0)
  ) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED, 'Choose a team and access you may manage.')
  }
  const reference = await prisma.executorPairingCode.findUnique({
    where: { codeVerifier: pairingCodeVerifier(secret, input.code) }, select: { id: true },
  })
  if (!reference) pairingUnavailable()
  return prisma.$transaction(async (tx) => {
    await lockPairing(tx, reference.id)
    const pairing = await tx.executorPairingCode.findUnique({
      where: { id: reference.id }, include: { executor: true },
    })
    if (!pairing || pairing.expiresAt <= now || pairing.rejectedAt) pairingUnavailable()
    if (pairing.fingerprint !== input.fingerprint) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.FINGERPRINT_NOT_CONFIRMED, 'Confirm this machine’s fingerprint.')
    }
    if (pairing.claimedAt) {
      const executor = pairing.executor
      const digest = executor ? pairingDigest(canonicalExecutorJson({
        executorId: executor.id, pairingId: pairing.id, organizationId: input.scope.organizationId,
        teamId: input.teamId, scope: input.scope, machineName: input.label,
      })) : null
      if (!executor || executor.pairingOwnerUserId !== authority.userId
        || executor.status === 'revoked' || digest !== pairing.claimDigest) pairingUnavailable()
      return { executorId: executor.id, pairingId: pairing.id, status: 'awaiting_confirmation' }
    }
    const descriptor = ExecutorSignedDescriptorSchema.parse(pairing.descriptor)
    const executor = await tx.executor.create({ data: {
      label: input.label, organizationId: input.scope.organizationId,
      projectId: input.scope.kind === 'project' ? input.scope.projectId : null,
      scopeKind: input.scope.kind, pairingOwnerUserId: authority.userId, pairingTeamId: input.teamId,
      profiles: descriptor.descriptor.profiles, status: 'pending_pairing',
      platformFacts: {
        platform: descriptor.descriptor.platform, supervisor: descriptor.descriptor.supervisor,
        sandboxBackend: descriptor.descriptor.sandboxBackend,
      },
      statusDetail: 'Waiting for confirmation on the machine.',
    } })
    if (input.scope.kind === 'private') await tx.executorPrivateAssignment.create({ data: {
      executorId: executor.id, principalKind: 'user', userId: authority.userId, role: 'admin',
    } })
    await tx.executorCapabilityRevision.create({ data: {
      executorId: executor.id, revision: descriptor.descriptor.revision,
      descriptor: descriptor.descriptor as Prisma.InputJsonValue,
      reviewStatus: 'active',
      signature: descriptor.signature, localPolicyDigest: descriptor.descriptor.localPolicyDigest,
    } })
    const claimDigest = pairingDigest(canonicalExecutorJson({
      executorId: executor.id, pairingId: pairing.id, organizationId: executor.organizationId,
      teamId: input.teamId, scope: input.scope, machineName: input.label,
    }))
    await tx.executorPairingCode.update({ where: { id: pairing.id }, data: {
      executorId: executor.id, claimedAt: now, claimDigest,
    } })
    await audit(tx, {
      action: 'executor.pairing.claimed', executorId: executor.id,
      organizationId: executor.organizationId, userId: authority.userId,
    })
    return { executorId: executor.id, pairingId: pairing.id, status: 'awaiting_confirmation' }
  })
}
