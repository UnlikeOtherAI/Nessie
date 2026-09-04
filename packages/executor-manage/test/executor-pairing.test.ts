import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'

import { ExecutorEnrollmentRequestSchema } from '@nessie/schemas'

import {
  assertValidExecutorEnrollmentProof,
  ExecutorError,
  submitExecutorEnrollment,
} from '../src/index.js'
import { canonicalExecutorJson, canonicalExecutorPayload } from '../src/executor-canonical-json.js'

const digest = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const enrollmentRequest = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const machinePublicKey = publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url')
  const descriptor = {
    protocolVersion: 1 as const,
    revision: 1,
    profiles: ['workspace_sandbox'] as const,
    platform: { architecture: 'arm64' as const, os: 'macos' as const, osMajorVersion: 15 },
    sandboxBackend: 'virtualization_framework' as const,
    supervisor: 'desktop' as const,
    operationKeys: ['file.list'] as const,
    localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1_024, maxSessions: 1 },
  }
  const enrollmentId = '00000000-0000-4000-8000-000000000001'
  const challenge = Buffer.alloc(32, 7).toString('base64url')
  const descriptorSignature = sign(
    null,
    canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor),
    privateKey,
  ).toString('base64url')
  const proof = sign(
    null,
    canonicalExecutorPayload('nessie.executor.enrollment.v1', {
      challenge,
      descriptorDigest: digest(canonicalExecutorJson(descriptor)),
      enrollmentId,
      machinePublicKey,
    }),
    privateKey,
  ).toString('base64url')
  return ExecutorEnrollmentRequestSchema.parse({
    enrollmentId,
    challenge,
    machinePublicKey,
    descriptor: { descriptor, signature: descriptorSignature },
    proof,
  })
}

test('canonical executor payload has stable sorted object keys', () => {
  assert.equal(canonicalExecutorJson({ z: [true, null], a: { b: 2, a: 1 } }), '{"a":{"a":1,"b":2},"z":[true,null]}')
})

test('enrollment requires signatures over the exact descriptor and enrollment facts', () => {
  const request = enrollmentRequest()
  assert.doesNotThrow(() => assertValidExecutorEnrollmentProof(request))

  const tampered = ExecutorEnrollmentRequestSchema.parse({
    ...request,
    descriptor: {
      ...request.descriptor,
      descriptor: { ...request.descriptor.descriptor, revision: 2 },
    },
  })
  assert.throws(
    () => assertValidExecutorEnrollmentProof(tampered),
    (error: unknown) => error instanceof ExecutorError && error.code === 'ENROLLMENT_PROOF_INVALID',
  )
})

const enrollmentPrisma = (request: ReturnType<typeof enrollmentRequest>) => {
  const state: Record<string, unknown> = {
    challengeVerifier: digest(request.challenge),
    consumedAt: null,
    descriptorDigest: null,
    executor: {
      id: '00000000-0000-4000-8000-000000000009',
      status: 'pending_pairing',
    },
    executorId: '00000000-0000-4000-8000-000000000009',
    expiresAt: new Date('2026-08-12T12:10:00.000Z'),
    id: request.enrollmentId,
    pendingFingerprint: null,
    pendingPublicKey: null,
  }
  let capabilityCreates = 0
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    $executeRaw: async () => undefined,
    executorEnrollment: {
      findUnique: async ({ include }: { include?: { executor: true } }) => include
        ? state
        : { executorId: state.executorId },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data)
        return state
      },
    },
    executorCapabilityRevision: {
      create: async () => {
        capabilityCreates += 1
        return {}
      },
    },
  } as unknown as PrismaClient
  return { capabilityCreates: () => capabilityCreates, prisma, state }
}

test('an exact enrollment submit replay returns the original pending result once', async () => {
  const request = enrollmentRequest()
  const { capabilityCreates, prisma } = enrollmentPrisma(request)
  const now = new Date('2026-08-12T12:00:00.000Z')

  const first = await submitExecutorEnrollment(prisma, request, now)
  const replay = await submitExecutorEnrollment(prisma, request, now)

  assert.deepEqual(replay, first)
  assert.equal(capabilityCreates(), 1)
})

test('an enrollment submit replay with a different machine key remains rejected', async () => {
  const firstRequest = enrollmentRequest()
  const { prisma } = enrollmentPrisma(firstRequest)
  const now = new Date('2026-08-12T12:00:00.000Z')
  await submitExecutorEnrollment(prisma, firstRequest, now)

  await assert.rejects(
    submitExecutorEnrollment(prisma, enrollmentRequest(), now),
    (error: unknown) => error instanceof ExecutorError && error.code === 'ENROLLMENT_USED',
  )
})
