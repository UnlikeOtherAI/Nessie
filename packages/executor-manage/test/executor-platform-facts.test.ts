import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import {
  ExecutorCapabilityDescriptorSchema,
  ExecutorSignedDescriptorSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import {
  canonicalExecutorPayload,
  listVisibleExecutors,
  submitExecutorDescriptor,
} from '../src/index.js'

const organizationId = '00000000-0000-4000-8000-0000000000a1'
const userId = '00000000-0000-4000-8000-0000000000a2'

const linuxDescriptor = (overrides: Record<string, unknown> = {}) =>
  ExecutorCapabilityDescriptorSchema.parse({
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    operationKeys: ['file.list', 'file.read'],
    platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision: 2,
    sandboxBackend: 'none',
    supervisor: 'service',
    ...overrides,
  })

const signedDescriptor = (descriptor: ReturnType<typeof linuxDescriptor>) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return {
    machinePublicKey: spki.subarray(-32).toString('base64url'),
    signed: ExecutorSignedDescriptorSchema.parse({
      descriptor,
      signature: sign(
        null,
        Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor)),
        privateKey,
      ).toString('base64url'),
    }),
  }
}

const descriptorPrisma = (machinePublicKey: string) => {
  const updates: Array<Record<string, unknown>> = []
  const client = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback({
      $executeRaw: async () => undefined,
      executor: {
        findUnique: async () => ({
          activeConnectionEpoch: 4n,
          id: 'executor-1',
          lastSeenAt: null,
          machinePublicKey,
          status: 'online',
        }),
        update: async (input: { data: Record<string, unknown> }) => {
          updates.push(input.data)
          return {}
        },
      },
      executorCapabilityRevision: {
        create: async () => ({ reviewStatus: 'pending_review', revision: 2 }),
        findFirst: async () => null,
      },
    }),
  } as unknown as PrismaClient
  return { client, updates }
}

test('a Linux service executor is accepted and its host facts are persisted', async () => {
  const descriptor = linuxDescriptor()
  const { machinePublicKey, signed } = signedDescriptor(descriptor)
  const { client, updates } = descriptorPrisma(machinePublicKey)

  assert.deepEqual(
    await submitExecutorDescriptor(client, {
      connectionEpoch: '4',
      descriptor: signed,
      executorId: 'executor-1',
    }),
    { reviewStatus: 'pending_review', revision: 2 },
  )
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0].platformFacts, {
    platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    sandboxBackend: 'none',
    supervisor: 'service',
  })
  assert.deepEqual(updates[0].profiles, ['workspace_sandbox'])
})

test('a Windows desktop executor persists its own backend and supervisor', async () => {
  const descriptor = linuxDescriptor({
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 22631 },
    sandboxBackend: 'hyperv',
    supervisor: 'desktop',
  })
  const { machinePublicKey, signed } = signedDescriptor(descriptor)
  const { client, updates } = descriptorPrisma(machinePublicKey)

  await submitExecutorDescriptor(client, {
    connectionEpoch: '4',
    descriptor: signed,
    executorId: 'executor-1',
  })
  assert.deepEqual(updates[0].platformFacts, {
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 22631 },
    sandboxBackend: 'hyperv',
    supervisor: 'desktop',
  })
})

const actorContext = {
  actor: { actorId: userId, actorType: 'user' },
  tenant: { organizationId },
} as unknown as AuthorizedActionContext

const listPrisma = (platformFacts: unknown) => ({
  executor: {
    findMany: async () => [{
      authorizationRevision: 1,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      id: '00000000-0000-4000-8000-0000000000a3',
      label: 'Ubuntu workstation',
      lastSeenAt: null,
      machineKeyFingerprint: null,
      organizationId,
      pairingOwnerUserId: userId,
      platformFacts,
      profiles: ['workspace_sandbox'],
      projectId: null,
      scopeKind: 'organization',
      status: 'online',
      statusDetail: null,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    }],
    updateMany: async () => ({ count: 0 }),
  },
  organizationMember: {
    findUnique: async () => ({ deactivatedAt: null, role: 'owner' }),
  },
  projectMember: {
    findMany: async () => [],
  },
} as unknown as PrismaClient)

test('the executor record exposes the host facts read-only', async () => {
  const [record] = await listVisibleExecutors(listPrisma({
    platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    sandboxBackend: 'firecracker',
    supervisor: 'service',
  }), actorContext)
  assert.deepEqual(record.platformFacts, {
    platform: { architecture: 'x64', os: 'linux', osMajorVersion: 6 },
    sandboxBackend: 'firecracker',
    supervisor: 'service',
  })
})

test('an executor that has never submitted a descriptor states no host facts', async () => {
  const [pending] = await listVisibleExecutors(listPrisma({}), actorContext)
  assert.equal(pending.platformFacts, undefined)
  // A pre-widening row holds only the platform triple; it is reported as
  // absent rather than half-guessed.
  const [legacy] = await listVisibleExecutors(
    listPrisma({ architecture: 'arm64', os: 'macos', osMajorVersion: 15 }),
    actorContext,
  )
  assert.equal(legacy.platformFacts, undefined)
})
