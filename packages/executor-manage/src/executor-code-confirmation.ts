import { Prisma, type Executor, type PrismaClient } from '@prisma/client'
import {
  ExecutorScopeSchema,
  type ExecutorPairingClaim, type ExecutorPairingPollResponse,
  type ExecutorPairingPollRequest, type ExecutorPairingDecisionRequest, type ExecutorPairingConnectionRequest,
} from '@nessie/schemas'
import {
  assertPairingProof, assertPairingTimestamp, lockPairing, pairingDigest,
  pairingUnavailable, revokePairingExecutor,
} from './executor-code-proof.js'
import { canonicalExecutorJson } from './executor-canonical-json.js'
import type { PairingAudit } from './executor-code-pairing.js'

export type PairingNames = (executor: Executor) => Promise<{
  organization: { id: string; name: string }; team: { id: string; name: string } | null
}>

const claimFor = async (
  executor: Executor, claimDigest: string, names: PairingNames,
): Promise<ExecutorPairingClaim> => ({
  executorId: executor.id, machineName: executor.label, ...(await names(executor)), claimDigest,
  scope: ExecutorScopeSchema.parse(executor.scopeKind === 'project'
    ? { kind: 'project', organizationId: executor.organizationId, projectId: executor.projectId }
    : { kind: executor.scopeKind, organizationId: executor.organizationId }),
})

export const pollExecutorCodePairing = async (
  prisma: PrismaClient, input: ExecutorPairingPollRequest, names: PairingNames, now = new Date(),
): Promise<ExecutorPairingPollResponse> => {
  assertPairingTimestamp(input.timestamp, now)
  const pairing = await prisma.executorPairingCode.findUnique({
    where: { id: input.pairingId }, include: { executor: true },
  })
  if (!pairing) pairingUnavailable()
  const { signature, ...payload } = input
  assertPairingProof(pairing.machinePublicKey, 'nessie.executor.pairing.poll.v1', payload, signature)
  const status = pairing.rejectedAt || pairing.executor?.status === 'revoked' ? 'rejected'
    : pairing.confirmedAt ? 'confirmed'
      : pairing.expiresAt <= now ? 'expired'
        : pairing.executorId ? 'awaiting_confirmation' : 'waiting'
  return {
    pairingId: pairing.id, fingerprint: pairing.fingerprint, expiresAt: pairing.expiresAt.toISOString(), status,
    ...(pairing.executor && pairing.claimDigest && (status === 'awaiting_confirmation' || status === 'confirmed')
      ? { claim: await claimFor(pairing.executor, pairing.claimDigest, names) } : {}),
  }
}

export const decideExecutorCodePairing = async (
  prisma: PrismaClient, input: ExecutorPairingDecisionRequest | ExecutorPairingPollRequest,
  action: 'confirm' | 'reject' | 'cancel', names: PairingNames, audit: PairingAudit, now = new Date(),
): Promise<ExecutorPairingPollResponse> => {
  assertPairingTimestamp(input.timestamp, now)
  // Resolve the names before activation. If the claiming person's live identity
  // is revoked or UOA unavailable, confirmation cannot create an active pairing.
  const initial = await prisma.executorPairingCode.findUnique({
    where: { id: input.pairingId }, include: { executor: true },
  })
  if (!initial) pairingUnavailable()
  const { signature, ...payload } = input
  assertPairingProof(initial.machinePublicKey, `nessie.executor.pairing.${action}.v1`, payload, signature)
  const claim = initial.executor && initial.claimDigest && action === 'confirm'
    ? await claimFor(initial.executor, initial.claimDigest, names) : undefined
  return prisma.$transaction(async (tx) => {
    await lockPairing(tx, input.pairingId)
    const pairing = await tx.executorPairingCode.findUnique({
      where: { id: input.pairingId }, include: { executor: true },
    })
    if (!pairing) pairingUnavailable()
    const executor = pairing.executor
    if (action !== 'cancel' && (
      !('executorId' in input) || input.executorId !== executor?.id || input.claimDigest !== pairing.claimDigest
    )) pairingUnavailable()
    if (pairing.confirmedAt && action !== 'confirm') pairingUnavailable()
    if (action === 'confirm' && (pairing.rejectedAt || (!pairing.confirmedAt && pairing.expiresAt <= now))) {
      pairingUnavailable()
    }
    if (action === 'confirm') {
      if (!executor || !claim || executor.status === 'revoked') pairingUnavailable()
      if (!pairing.confirmedAt) {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`executor-key:${pairing.fingerprint}`}, 0))
        `)
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executor.id}`}, 0))
        `)
        const current = await tx.executor.findUnique({ where: { id: executor.id } })
        if (!current || current.status !== 'pending_pairing') pairingUnavailable()
        const collision = await tx.executor.findUnique({ where: { machineKeyFingerprint: pairing.fingerprint } })
        if (collision) pairingUnavailable()
        await tx.executor.update({ where: { id: executor.id }, data: {
          machinePublicKey: pairing.machinePublicKey, machineKeyFingerprint: pairing.fingerprint,
          status: 'offline', statusDetail: 'Awaiting authenticated executor connection.',
        } })
        await tx.executorPairingCode.update({ where: { id: pairing.id }, data: { confirmedAt: now } })
        await audit(tx, {
          action: 'executor.pairing.confirmed', executorId: executor.id,
          organizationId: executor.organizationId, userId: executor.pairingOwnerUserId,
        })
      }
    } else if (!pairing.rejectedAt) {
      if (executor) {
        await revokePairingExecutor(tx, executor.id)
        await audit(tx, {
          action: 'executor.pairing.rejected', executorId: executor.id,
          organizationId: executor.organizationId, userId: executor.pairingOwnerUserId,
        })
      }
      await tx.executorPairingCode.update({ where: { id: pairing.id }, data: { rejectedAt: now } })
    }
    return {
      pairingId: pairing.id, fingerprint: pairing.fingerprint, expiresAt: pairing.expiresAt.toISOString(),
      status: action === 'confirm' ? 'confirmed' : 'rejected', ...(claim ? { claim } : {}),
    }
  })
}

export const readExecutorPairingConnection = async (
  prisma: PrismaClient, input: ExecutorPairingConnectionRequest, names: PairingNames, now = new Date(),
): Promise<ExecutorPairingClaim> => {
  assertPairingTimestamp(input.timestamp, now)
  const executor = await prisma.executor.findUnique({ where: { id: input.executorId } })
  if (!executor?.machinePublicKey || executor.status === 'revoked') pairingUnavailable()
  const { signature, ...payload } = input
  assertPairingProof(executor.machinePublicKey, 'nessie.executor.pairing.connection.v1', payload, signature)
  return claimFor(executor, pairingDigest(canonicalExecutorJson({
    executorId: executor.id, organizationId: executor.organizationId, teamId: executor.pairingTeamId,
  })), names)
}
