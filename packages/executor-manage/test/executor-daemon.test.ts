import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { ExecutorSignedDescriptorSchema } from '@nessie/schemas'

import {
  canonicalExecutorPayload,
  claimExecutorConnection,
  ExecutorError,
  verifyExecutorDescriptorSignature,
  verifyExecutorDaemonSignature,
} from '../src/index.js'

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKey,
    publicKey: spki.toString('base64url'),
    rawPublicKey: spki.subarray(-32).toString('base64url'),
  }
}

test('daemon claim signatures are domain-separated and bind the exact challenge', () => {
  const keys = keyPair()
  const payload = { challenge: 'server-challenge', executorId: 'executor-1' }
  const signature = sign(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.claim.v1', payload)),
    keys.privateKey,
  ).toString('base64url')

  assert.equal(verifyExecutorDaemonSignature(keys.publicKey, 'claim', payload, signature), true)
  assert.equal(verifyExecutorDaemonSignature(keys.publicKey, 'heartbeat', payload, signature), false)
  assert.equal(verifyExecutorDaemonSignature(
    keys.publicKey,
    'claim',
    { ...payload, challenge: 'other-challenge' },
    signature,
  ), false)
})

test('daemon signatures accept the raw key representation stored at enrollment', () => {
  const keys = keyPair()
  const payload = { challenge: 'server-challenge', executorId: 'executor-1' }
  const signature = sign(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.claim.v1', payload)),
    keys.privateKey,
  ).toString('base64url')
  assert.equal(verifyExecutorDaemonSignature(keys.rawPublicKey, 'claim', payload, signature), true)
})

test('control receipts have their own signature domain', () => {
  const keys = keyPair()
  const payload = {
    connectionEpoch: '7',
    executorId: 'executor-1',
    receipt: { commandId: 'command-1', occurredAt: '2026-08-12T12:00:00.000Z', state: 'accepted' },
  }
  const signature = sign(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.receipt.v1', payload)),
    keys.privateKey,
  ).toString('base64url')
  assert.equal(verifyExecutorDaemonSignature(keys.rawPublicKey, 'receipt', payload, signature), true)
  assert.equal(verifyExecutorDaemonSignature(keys.rawPublicKey, 'poll', payload, signature), false)
})

test('descriptor signatures bind the complete advertised local policy', () => {
  const keys = keyPair()
  const descriptorFacts = {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1_024, maxSessions: 1 },
    localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    operationKeys: ['file.read'],
    platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
    sandboxBackend: 'virtualization_framework',
    supervisor: 'desktop',
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision: 2,
  }
  const descriptor = ExecutorSignedDescriptorSchema.parse({
    descriptor: descriptorFacts,
    signature: sign(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptorFacts)),
    keys.privateKey,
    ).toString('base64url'),
  })
  assert.equal(verifyExecutorDescriptorSignature(keys.rawPublicKey, descriptor), true)
  assert.equal(verifyExecutorDescriptorSignature(keys.rawPublicKey, {
    ...descriptor,
    descriptor: { ...descriptor.descriptor, revision: 3 },
  }), false)
})

const claimPrisma = (machinePublicKey: string, challengeMatches: number) => {
  const updateManyCalls: Array<Record<string, unknown>> = []
  const client = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback({
      $executeRaw: async () => undefined,
      executor: {
        findUnique: async () => ({
          activeConnectionEpoch: 4n,
          id: 'executor-1',
          lastSeenAt: null,
          machinePublicKey,
          status: 'offline',
        }),
        update: async () => ({ activeConnectionEpoch: 5n, status: 'online' }),
      },
      executorDaemonChallenge: {
        updateMany: async (input: Record<string, unknown>) => {
          updateManyCalls.push(input)
          return { count: challengeMatches }
        },
      },
    }),
  } as unknown as PrismaClient
  return { client, updateManyCalls }
}

test('daemon claim consumes exactly one stored challenge before advancing its fence', async () => {
  const keys = keyPair()
  const { client, updateManyCalls } = claimPrisma(keys.publicKey, 1)
  const challenge = 'server-challenge'
  const signature = sign(
    null,
    Buffer.from(canonicalExecutorPayload(
      'nessie.executor.daemon.claim.v1',
      { challenge, executorId: 'executor-1' },
    )),
    keys.privateKey,
  ).toString('base64url')
  assert.deepEqual(
    await claimExecutorConnection(client, { challenge, executorId: 'executor-1', signature }),
    { connectionEpoch: '5', status: 'online' },
  )
  assert.equal(updateManyCalls.length, 1)
  assert.equal((updateManyCalls[0].where as { consumedAt: null }).consumedAt, null)
})

test('a previously consumed daemon challenge cannot advance the connection fence', async () => {
  const keys = keyPair()
  const { client } = claimPrisma(keys.publicKey, 0)
  const challenge = 'server-challenge'
  const signature = sign(
    null,
    Buffer.from(canonicalExecutorPayload(
      'nessie.executor.daemon.claim.v1',
      { challenge, executorId: 'executor-1' },
    )),
    keys.privateKey,
  ).toString('base64url')
  await assert.rejects(
    claimExecutorConnection(client, { challenge, executorId: 'executor-1', signature }),
    (error: unknown) => error instanceof ExecutorError
      && error.code === 'EXECUTOR_DAEMON_CHALLENGE_INVALID',
  )
})
