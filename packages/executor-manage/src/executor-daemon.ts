import { createHash, createPublicKey, verify } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { ExecutorSignedDescriptor } from '@nessie/schemas'

import { canonicalExecutorPayload } from './executor-canonical-json.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

const HEARTBEAT_SKEW_MS = 60_000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const challengeHash = (challenge: string): string =>
  `sha256:${createHash('sha256').update(challenge).digest('hex')}`

const machineKey = (encoded: string) => {
  try {
    const decoded = Buffer.from(encoded, 'base64url')
    return createPublicKey({
      format: 'der',
      // Enrollment stores the compact raw Ed25519 public key. Accepting an
      // SPKI wrapper as well keeps this verifier compatible with the earlier
      // internal test fixture, but the paired database representation is the
      // 32-byte form and is always wrapped before Node parses it.
      key: decoded.length === 32
        ? Buffer.concat([ED25519_SPKI_PREFIX, decoded])
        : decoded,
      type: 'spki',
    })
  } catch {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.DAEMON_PROOF_INVALID,
      'Executor machine key is invalid.',
    )
  }
}

export const verifyExecutorDaemonSignature = (
  machinePublicKey: string,
  domain: 'claim' | 'heartbeat',
  payload: Record<string, unknown>,
  signature: string,
): boolean => {
  try {
    return verify(
      null,
      Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.${domain}.v1`, payload)),
      machineKey(machinePublicKey),
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}

/** The capability descriptor is signed directly by the paired machine key. */
export const verifyExecutorDescriptorSignature = (
  machinePublicKey: string,
  descriptor: ExecutorSignedDescriptor,
): boolean => {
  try {
    return verify(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor.descriptor)),
      machineKey(machinePublicKey),
      Buffer.from(descriptor.signature, 'base64url'),
    )
  } catch {
    return false
  }
}

const lockExecutorConnection = async (
  tx: Prisma.TransactionClient,
  executorId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executorId}`}, 0))
  `)
}

const requireDaemonExecutor = async (
  tx: Prisma.TransactionClient,
  executorId: string,
) => {
  const executor = await tx.executor.findUnique({
    where: { id: executorId },
    select: {
      activeConnectionEpoch: true,
      id: true,
      lastSeenAt: true,
      machinePublicKey: true,
      status: true,
    },
  })
  if (
    !executor
    || !executor.machinePublicKey
    || executor.status === 'pending_pairing'
    || executor.status === 'revoked'
  ) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor is unavailable.')
  }
  return { ...executor, machinePublicKey: executor.machinePublicKey as string }
}

/**
 * Persist the opaque, signed challenge only for an already paired executor.
 * Treating every other id identically prevents this public endpoint from
 * becoming an executor-enumeration oracle.
 */
export const recordExecutorDaemonChallenge = async (
  prisma: PrismaClient,
  input: { challenge: string; executorId: string; expiresAt: Date },
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await lockExecutorConnection(tx, input.executorId)
    const executor = await tx.executor.findUnique({
      where: { id: input.executorId },
      select: { id: true, machinePublicKey: true, status: true },
    })
    if (
      !executor
      || !executor.machinePublicKey
      || executor.status === 'pending_pairing'
      || executor.status === 'revoked'
    ) return
    const now = new Date()
    await tx.executorDaemonChallenge.deleteMany({
      where: {
        executorId: executor.id,
        OR: [{ expiresAt: { lte: now } }, { consumedAt: null }],
      },
    })
    await tx.executorDaemonChallenge.create({
      data: {
        executorId: executor.id,
        challengeHash: challengeHash(input.challenge),
        expiresAt: input.expiresAt,
      },
    })
  })
}

export const claimExecutorConnection = async (
  prisma: PrismaClient,
  input: { challenge: string; executorId: string; signature: string },
): Promise<{ connectionEpoch: string; status: string }> => prisma.$transaction(async (tx) => {
  await lockExecutorConnection(tx, input.executorId)
  const executor = await requireDaemonExecutor(tx, input.executorId)
  if (!verifyExecutorDaemonSignature(
    executor.machinePublicKey,
    'claim',
    { challenge: input.challenge, executorId: executor.id },
    input.signature,
  )) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.DAEMON_PROOF_INVALID, 'Executor proof is invalid.')
  }
  const consumedChallenge = await tx.executorDaemonChallenge.updateMany({
    where: {
      executorId: executor.id,
      challengeHash: challengeHash(input.challenge),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  })
  if (consumedChallenge.count !== 1) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.DAEMON_CHALLENGE_INVALID,
      'Executor challenge is invalid or has already been used.',
    )
  }
  const updated = await tx.executor.update({
    where: { id: executor.id },
    data: {
      activeConnectionEpoch: { increment: 1 },
      lastSeenAt: new Date(),
      status: executor.status === 'paused' ? 'paused' : 'online',
      statusDetail: executor.status === 'paused'
        ? 'Executor is paused while the daemon is connected.'
        : 'Authenticated executor daemon connected.',
    },
    select: { activeConnectionEpoch: true, status: true },
  })
  return { connectionEpoch: updated.activeConnectionEpoch.toString(), status: updated.status }
})

export const reportExecutorHeartbeat = async (
  prisma: PrismaClient,
  input: {
    connectionEpoch: string
    executorId: string
    observedAt: string
    signature: string
  },
  now = new Date(),
): Promise<{ connectionEpoch: string; status: string }> => {
  const observedAt = new Date(input.observedAt)
  if (Number.isNaN(observedAt.getTime()) || Math.abs(now.getTime() - observedAt.getTime()) > HEARTBEAT_SKEW_MS) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.HEARTBEAT_STALE, 'Executor heartbeat is stale.')
  }
  return prisma.$transaction(async (tx) => {
    await lockExecutorConnection(tx, input.executorId)
    const executor = await requireDaemonExecutor(tx, input.executorId)
    if (executor.activeConnectionEpoch.toString() !== input.connectionEpoch) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.CONNECTION_FENCED, 'Executor connection is fenced.')
    }
    if (!verifyExecutorDaemonSignature(
      executor.machinePublicKey,
      'heartbeat',
      {
        connectionEpoch: input.connectionEpoch,
        executorId: executor.id,
        observedAt: input.observedAt,
      },
      input.signature,
    )) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.DAEMON_PROOF_INVALID, 'Executor proof is invalid.')
    }
    const updated = await tx.executor.update({
      where: { id: executor.id },
      data: {
        lastSeenAt: !executor.lastSeenAt || observedAt > executor.lastSeenAt
          ? observedAt
          : executor.lastSeenAt,
        status: executor.status === 'offline' ? 'online' : executor.status,
        statusDetail: executor.status === 'offline'
          ? 'Authenticated executor daemon connected.'
          : undefined,
      },
      select: { activeConnectionEpoch: true, status: true },
    })
    return { connectionEpoch: updated.activeConnectionEpoch.toString(), status: updated.status }
  })
}

/**
 * Descriptor revisions only ever advance. A new revision becomes pending
 * review, so a daemon cannot expand its own cloud-authorized capability set.
 */
export const submitExecutorDescriptor = async (
  prisma: PrismaClient,
  input: {
    connectionEpoch: string
    descriptor: ExecutorSignedDescriptor
    executorId: string
  },
): Promise<{ reviewStatus: string; revision: number }> => prisma.$transaction(async (tx) => {
  await lockExecutorConnection(tx, input.executorId)
  const executor = await requireDaemonExecutor(tx, input.executorId)
  if (executor.activeConnectionEpoch.toString() !== input.connectionEpoch) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.CONNECTION_FENCED, 'Executor connection is fenced.')
  }
  if (!verifyExecutorDescriptorSignature(executor.machinePublicKey, input.descriptor)) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.DAEMON_PROOF_INVALID, 'Executor descriptor proof is invalid.')
  }
  const latest = await tx.executorCapabilityRevision.findFirst({
    where: { executorId: executor.id },
    orderBy: { revision: 'desc' },
    select: { descriptor: true, revision: true, reviewStatus: true },
  })
  const revision = input.descriptor.descriptor.revision
  if (latest && revision < latest.revision) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.DESCRIPTOR_ROLLBACK,
      'Executor descriptor revisions cannot move backwards.',
    )
  }
  if (latest && revision === latest.revision) {
    const current = canonicalExecutorPayload('nessie.executor.descriptor.v1', latest.descriptor)
    const proposed = canonicalExecutorPayload(
      'nessie.executor.descriptor.v1',
      input.descriptor.descriptor,
    )
    if (!current.equals(proposed)) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.DESCRIPTOR_REVISION_CONFLICT,
        'A descriptor revision cannot describe two different policies.',
      )
    }
    return { reviewStatus: latest.reviewStatus, revision: latest.revision }
  }
  const created = await tx.executorCapabilityRevision.create({
    data: {
      executorId: executor.id,
      revision,
      descriptor: input.descriptor.descriptor as Prisma.InputJsonValue,
      localPolicyDigest: input.descriptor.descriptor.localPolicyDigest,
      signature: input.descriptor.signature,
    },
    select: { reviewStatus: true, revision: true },
  })
  await tx.executor.update({
    where: { id: executor.id },
    data: {
      platformFacts: {
        architecture: input.descriptor.descriptor.platform.architecture,
        os: input.descriptor.descriptor.platform.os,
        osMajorVersion: input.descriptor.descriptor.platform.osMajorVersion,
      },
      profiles: input.descriptor.descriptor.profiles,
    },
  })
  return created
})
