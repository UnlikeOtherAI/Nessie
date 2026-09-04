import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import { ExecutorEnrollmentRequestSchema } from '@nessie/schemas'

import {
  assertValidExecutorEnrollmentProof,
  ExecutorError,
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
