import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  ExecutorEnrollmentRequest,
} from '@nessie/schemas'
import { ExecutorEnrollmentRequestSchema } from '@nessie/schemas'
import type { z } from 'zod'

import {
  canManageExecutor,
  requireHumanActor,
  resolveExecutorHumanAccess,
} from './executor-access.js'
import { canonicalExecutorJson, canonicalExecutorPayload } from './executor-canonical-json.js'
import { getExecutorForManagement } from './executor-records.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const digest = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const fingerprint = (machinePublicKey: string): string =>
  `sha256:${createHash('sha256').update(machinePublicKey).digest('hex')}`

const verifierFor = (challenge: string): Buffer =>
  Buffer.from(digest(challenge), 'utf8')

const decodeBase64Url = (value: string): Buffer => Buffer.from(value, 'base64url')

const executorPublicKey = (machinePublicKey: string) => {
  const raw = decodeBase64Url(machinePublicKey)
  if (raw.length !== 32) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID,
      'Executor public keys must be Ed25519 raw public keys.',
    )
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

export const assertValidExecutorEnrollmentProof = (input: ExecutorEnrollmentRequest): void => {
  const descriptorDigest = digest(canonicalExecutorJson(input.descriptor.descriptor))
  const publicKey = executorPublicKey(input.machinePublicKey)
  const descriptorValid = verify(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', input.descriptor.descriptor)),
    publicKey,
    decodeBase64Url(input.descriptor.signature),
  )
  const enrollmentValid = verify(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.enrollment.v1', {
      challenge: input.challenge,
      descriptorDigest,
      enrollmentId: input.enrollmentId,
      machinePublicKey: input.machinePublicKey,
    })),
    publicKey,
    decodeBase64Url(input.proof),
  )
  if (!descriptorValid || !enrollmentValid) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID,
      'Executor enrollment proof is invalid.',
    )
  }
}

export type PendingExecutorEnrollment = {
  executorId: string
  fingerprint: string
  descriptorDigest: string
  expiresAt: string
}

/**
 * A public enrollment endpoint may call this function: possession of the
 * 256-bit invitation challenge and a valid key proof are both mandatory, and
 * the verifier is consumed only after the human confirmation transaction.
 */
export const submitExecutorEnrollment = async (
  prisma: PrismaClient,
  input: z.input<typeof ExecutorEnrollmentRequestSchema>,
  now = new Date(),
): Promise<PendingExecutorEnrollment> => {
  const parsed = ExecutorEnrollmentRequestSchema.parse(input)
  assertValidExecutorEnrollmentProof(parsed)
  const descriptorDigest = digest(canonicalExecutorJson(parsed.descriptor.descriptor))
  const publicKeyFingerprint = fingerprint(parsed.machinePublicKey)
  const enrollmentReference = await prisma.executorEnrollment.findUnique({
    where: { id: parsed.enrollmentId },
    select: { executorId: true },
  })
  if (!enrollmentReference) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_USED, 'Enrollment is unavailable.')
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${enrollmentReference.executorId}`}, 0))
    `)
    const enrollment = await tx.executorEnrollment.findUnique({
      where: { id: parsed.enrollmentId },
      include: { executor: true },
    })
    if (!enrollment || enrollment.executorId !== enrollment.executor.id) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_USED, 'Enrollment is unavailable.')
    }
    if (enrollment.expiresAt <= now) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_EXPIRED, 'Enrollment has expired.')
    }
    const expectedVerifier = verifierFor(parsed.challenge)
    const actualVerifier = Buffer.from(enrollment.challengeVerifier, 'utf8')
    const challengeMatches = expectedVerifier.length === actualVerifier.length
      && timingSafeEqual(expectedVerifier, actualVerifier)
    if (!challengeMatches) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID,
        'Executor enrollment proof is invalid.',
      )
    }
    if (enrollment.consumedAt) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_USED, 'Enrollment was already used.')
    }
    if (enrollment.executor.status !== 'pending_pairing') {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_USED, 'Executor is no longer pairable.')
    }
    if (enrollment.pendingPublicKey) {
      if (
        enrollment.pendingPublicKey === parsed.machinePublicKey
        && enrollment.pendingFingerprint === publicKeyFingerprint
        && enrollment.descriptorDigest === descriptorDigest
      ) {
        return {
          executorId: enrollment.executorId,
          fingerprint: publicKeyFingerprint,
          descriptorDigest,
          expiresAt: enrollment.expiresAt.toISOString(),
        }
      }
      throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_USED, 'Enrollment was already used.')
    }

    await tx.executorEnrollment.update({
      where: { id: enrollment.id },
      data: {
        descriptorDigest,
        pendingFingerprint: publicKeyFingerprint,
        pendingPublicKey: parsed.machinePublicKey,
      },
    })
    await tx.executorCapabilityRevision.create({
      data: {
        executorId: enrollment.executorId,
        revision: parsed.descriptor.descriptor.revision,
        descriptor: parsed.descriptor.descriptor as Prisma.InputJsonValue,
        localPolicyDigest: parsed.descriptor.descriptor.localPolicyDigest,
        signature: parsed.descriptor.signature,
      },
    })
    return {
      executorId: enrollment.executorId,
      fingerprint: publicKeyFingerprint,
      descriptorDigest,
      expiresAt: enrollment.expiresAt.toISOString(),
    }
  })
}

export const getPendingExecutorEnrollment = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<PendingExecutorEnrollment | null> => {
  const managed = await getExecutorForManagement(prisma, actorContext, executorId)
  if (!managed) return null
  const enrollment = await prisma.executorEnrollment.findFirst({
    where: {
      executorId,
      consumedAt: null,
      pendingFingerprint: { not: null },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!enrollment?.pendingFingerprint || !enrollment.descriptorDigest) return null
  return {
    executorId,
    fingerprint: enrollment.pendingFingerprint,
    descriptorDigest: enrollment.descriptorDigest,
    expiresAt: enrollment.expiresAt.toISOString(),
  }
}

export const confirmExecutorEnrollment = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { executorId: string; fingerprint: string },
  now = new Date(),
): Promise<void> => {
  const managed = await getExecutorForManagement(prisma, actorContext, input.executorId)
  if (!managed) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${input.executorId}`}, 0))
    `)
    const actorUserId = requireHumanActor(actorContext)
    const executor = actorUserId
      ? await tx.executor.findFirst({
          where: {
            id: input.executorId,
            organizationId: actorContext.tenant.organizationId,
          },
        })
      : null
    const access = executor && actorUserId
      ? await resolveExecutorHumanAccess(
          tx,
          actorContext.tenant.organizationId,
          actorUserId,
          executor,
        )
      : null
    if (!executor || !access || !canManageExecutor(executor, access)) {
      throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
    }
    const enrollment = await tx.executorEnrollment.findFirst({
      where: {
        executorId: input.executorId,
        consumedAt: null,
        pendingFingerprint: { not: null },
        pendingPublicKey: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!enrollment || enrollment.expiresAt <= now) {
      throw new ExecutorError(
        enrollment ? EXECUTOR_ERROR_CODES.ENROLLMENT_EXPIRED : EXECUTOR_ERROR_CODES.FINGERPRINT_NOT_CONFIRMED,
        'No active executor enrollment is ready to confirm.',
      )
    }
    if (enrollment.pendingFingerprint !== input.fingerprint || !enrollment.pendingPublicKey) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.FINGERPRINT_NOT_CONFIRMED,
        'The confirmation fingerprint does not match the pending executor.',
      )
    }
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`executor-key:${enrollment.pendingFingerprint}`}, 0))
    `)
    const pairedElsewhere = await tx.executor.findFirst({
      where: {
        machineKeyFingerprint: enrollment.pendingFingerprint,
        NOT: { id: input.executorId },
      },
      select: { id: true },
    })
    if (pairedElsewhere) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID,
        'This executor key is already paired.',
      )
    }
    await tx.executor.update({
      where: { id: input.executorId },
      data: {
        machineKeyFingerprint: enrollment.pendingFingerprint,
        machinePublicKey: enrollment.pendingPublicKey,
        status: 'offline',
        statusDetail: 'Awaiting authenticated executor connection.',
      },
    })
    await tx.executorEnrollment.update({
      where: { id: enrollment.id },
      data: { consumedAt: now },
    })
  })
}
