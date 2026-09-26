import { applyExecutorCapabilityUpdate } from './executor-capability-update.js'
import type { ExecutorLeaseRef } from './executor-conversation-lease.js'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ExecutorPlatformFactsSchema,
  type ExecutorLocalMcpReport,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { canonicalExecutorPayload } from './executor-canonical-json.js'
import { takeExecutorCodingSessionClosesInTransaction } from './executor-coding-session-closes.js'
import { enforceTicketWorkLimitsInTransaction } from './executor-standing-policy-limits.js'
import { recordTicketWorkHeartbeatCostsInTransaction } from './ticket-work-heartbeat-costs.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import {
  EXECUTOR_HEARTBEAT_FRESHNESS_MS,
  expireStaleExecutorHeartbeats,
} from './executor-liveness.js'
import {
  enqueueTicketWorkForMachineInTransaction,
  executorWasOffline,
  intakeTicketWorkHeartbeatInTransaction,
  withLastKnownCodingSessions,
} from './ticket-work-session-intake.js'

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

/**
 * The signed domains of an authenticated daemon control call. Each is its own
 * domain so that no call can be replayed as another: an image upload
 * (`attachment`) is not a receipt, and a receipt is not a poll.
 */
export type ExecutorDaemonControlType =
  | 'session_view'
  | 'attachment'
  | 'browser_cookie_import.poll'
  | 'browser_cookie_import.upload'
  | 'local_inference.host'
  | 'poll'
  | 'receipt'

export const verifyExecutorDaemonSignature = (
  machinePublicKey: string,
  domain: ExecutorDaemonControlType | 'claim' | 'heartbeat',
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
      scopeKind: true,
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
  const claimedAt = new Date()
  const updated = await tx.executor.update({
    where: { id: executor.id },
    data: {
      activeConnectionEpoch: { increment: 1 },
      lastSeenAt: claimedAt,
      status: executor.status === 'offline' ? 'online' : executor.status,
      statusDetail: executor.status === 'offline'
        ? 'Authenticated executor daemon connected.'
        : executor.status === 'paused'
          ? 'Executor is paused while the daemon is connected.'
          : undefined,
    },
    select: { activeConnectionEpoch: true, status: true },
  })
  // A machine back online resumes the ticket work waiting for it and takes queued work.
  if (updated.status === 'online') {
    await enqueueTicketWorkForMachineInTransaction(tx, {
      cameOnline: executorWasOffline(executor, claimedAt), executorId: executor.id, now: claimedAt,
    })
  }
  return { connectionEpoch: updated.activeConnectionEpoch.toString(), status: updated.status }
})

/**
 * A heartbeat stores the daemon's local-MCP report and answers with the
 * coding sessions it must close (`codingSessionClose`, absent when there are
 * none): the report it carried settles the requests it shows done first.
 */
export const reportExecutorHeartbeat = async (
  prisma: PrismaClient,
  input: {
    connectionEpoch: string
    executorId: string
    localMcp?: ExecutorLocalMcpReport
    observedAt: string
    signature: string
  },
  now = new Date(),
): Promise<{
  existingSessionsAllowed: boolean
  codingSessionClose?: Array<{ ownerKey: string; reason: string; sessionId?: string }>
  connectionEpoch: string
  status: string
}> => {
  const observedAt = new Date(input.observedAt)
  if (
    Number.isNaN(observedAt.getTime())
    || Math.abs(now.getTime() - observedAt.getTime()) > EXECUTOR_HEARTBEAT_FRESHNESS_MS
  ) {
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
        // The field joins the signed payload exactly when the daemon sent it.
        // Canonical JSON distinguishes an absent key from a present one, so a
        // daemon too old to report still verifies the payload it always sent.
        ...(input.localMcp === undefined ? {} : { localMcp: input.localMcp }),
        observedAt: input.observedAt,
      },
      input.signature,
    )) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.DAEMON_PROOF_INVALID, 'Executor proof is invalid.')
    }
    // The report this one replaces, for the session intake to compare against.
    const previousLocalMcp = input.localMcp === undefined
      ? null
      : (await tx.executor.findUnique({ where: { id: executor.id }, select: { localMcp: true } }))?.localMcp ?? null
    const updated = await tx.executor.update({
      where: { id: executor.id },
      data: {
        lastSeenAt: !executor.lastSeenAt || observedAt > executor.lastSeenAt
          ? observedAt
          : executor.lastSeenAt,
        // Absent leaves the stored report alone: a daemon that stops reporting
        // has not told us its servers vanished, and overwriting the last
        // observation with nothing would destroy the only thing we know.
        // The same holds for the coding bridge's sessions within a report that
        // was taken without them: the last list stays until one replaces it.
        ...(input.localMcp === undefined
          ? {}
          : {
              localMcp: withLastKnownCodingSessions(previousLocalMcp, input.localMcp),
              localMcpObservedAt: observedAt,
            }),
        status: executor.status === 'offline' ? 'online' : executor.status,
        statusDetail: executor.status === 'offline'
          ? 'Authenticated executor daemon connected.'
          : undefined,
      },
      select: { activeConnectionEpoch: true, status: true },
    })
    // The heartbeat intake: what the ticket's sessions here cost since they
    // were last counted, then a ticket working on this machine — or charged
    // by it — past one of its limits stops here, and its sessions' closes
    // ride this very answer; then its sessions' turns, interruptions and
    // closes wake their tickets, and a machine back online resumes the work
    // waiting for it (T5).
    const charged = await recordTicketWorkHeartbeatCostsInTransaction(tx, {
      executorId: executor.id, localMcp: input.localMcp, now,
    })
    await enforceTicketWorkLimitsInTransaction(tx, {
      now,
      where: {
        OR: [{ executorId: executor.id, status: 'active' }, ...(charged.length > 0 ? [{ id: { in: charged } }] : [])],
      },
    })
    if (updated.status === 'online') {
      await intakeTicketWorkHeartbeatInTransaction(tx, {
        cameOnline: executorWasOffline(executor, now),
        executorId: executor.id,
        ...(input.localMcp === undefined ? {} : { localMcp: input.localMcp }),
        now,
        previousLocalMcp,
      })
    }
    const codingSessionClose = await takeExecutorCodingSessionClosesInTransaction(tx, {
      executorId: executor.id, ...(input.localMcp === undefined ? {} : { localMcp: input.localMcp }), now,
    })
    return {
      existingSessionsAllowed: executor.scopeKind === 'private',
      ...(codingSessionClose.length > 0 ? { codingSessionClose } : {}),
      connectionEpoch: updated.activeConnectionEpoch.toString(),
      status: updated.status,
    }
  })
}

/**
 * Descriptor revisions only ever advance and become active with
 * runtime fencing. Human access is managed separately through direct sharing.
 */
export const submitExecutorDescriptor = async (
  prisma: PrismaClient,
  input: {
    connectionEpoch: string
    descriptor: ExecutorSignedDescriptor
    executorId: string
  },
): Promise<{
  reviewStatus: string; revision: number; endedLeases?: ExecutorLeaseRef[]
}> => prisma.$transaction(async (tx) => {
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
    if (current !== proposed) {
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
      reviewStatus: 'active',
    },
    select: { reviewStatus: true, revision: true },
  })
  await tx.executor.update({
    where: { id: executor.id },
    data: {
      // The host facts the machine signed, denormalized so the Executors page
      // can name the computer and its supervisor without re-reading a
      // capability revision. Server-written only; no API caller can set them.
      platformFacts: ExecutorPlatformFactsSchema.parse({
        platform: input.descriptor.descriptor.platform,
        sandboxBackend: input.descriptor.descriptor.sandboxBackend,
        supervisor: input.descriptor.descriptor.supervisor,
      }),
      profiles: input.descriptor.descriptor.profiles,
    },
  })
  if (latest) return {
    ...created, endedLeases: await applyExecutorCapabilityUpdate(tx, executor.id, input.descriptor.descriptor),
  }
  return created
})

/**
 * Validate an authenticated daemon control call. This deliberately uses its
 * own signed domain so a heartbeat cannot be replayed as a poll or receipt.
 */
export const authorizeExecutorDaemonControlCall = async <Result>(
  prisma: PrismaClient,
  input: {
    connectionEpoch: string
    executorId: string
    observedAt: string
    payload: Record<string, unknown>
    signature: string
    type: ExecutorDaemonControlType
  },
  action: (tx: Prisma.TransactionClient) => Promise<Result>,
  now = new Date(),
): Promise<Result> => {
  const observedAt = new Date(input.observedAt)
  if (
    Number.isNaN(observedAt.getTime())
    || Math.abs(now.getTime() - observedAt.getTime()) > EXECUTOR_HEARTBEAT_FRESHNESS_MS
  ) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.HEARTBEAT_STALE, 'Executor control call is stale.')
  }
  return prisma.$transaction(async (tx) => {
    await lockExecutorConnection(tx, input.executorId)
    await expireStaleExecutorHeartbeats(tx, { executorId: input.executorId }, now)
    const executor = await requireDaemonExecutor(tx, input.executorId)
    if (executor.status !== 'online' || executor.activeConnectionEpoch.toString() !== input.connectionEpoch) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.CONNECTION_FENCED, 'Executor connection is fenced.')
    }
    if (!verifyExecutorDaemonSignature(
      executor.machinePublicKey,
      input.type,
      input.payload,
      input.signature,
    )) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.DAEMON_PROOF_INVALID, 'Executor proof is invalid.')
    }
    await tx.executor.update({
      where: { id: executor.id },
      data: { lastSeenAt: !executor.lastSeenAt || observedAt > executor.lastSeenAt ? observedAt : executor.lastSeenAt },
    })
    return action(tx)
  })
}
