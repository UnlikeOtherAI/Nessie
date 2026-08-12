import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  bindExecutorCandidate,
  bindExecutorCandidateBundleInTransaction,
  executorCandidateHandleDigest,
} from '../src/index.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const actorUserId = '00000000-0000-4000-8000-000000000002'
const agentId = '00000000-0000-4000-8000-000000000003'
const executorId = '00000000-0000-4000-8000-000000000004'
const capabilityRevisionId = '00000000-0000-4000-8000-000000000005'
const runId = '00000000-0000-4000-8000-000000000006'
const handle = 'a'.repeat(43)

const descriptor = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  localPolicyDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  operationKeys: ['file.read', 'sandbox.stop', 'workspace.review'],
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  profiles: ['workspace_sandbox'],
  protocolVersion: 1,
  revision: 1,
}

const executor = {
  authorizationRevision: 7,
  capabilityRevisions: [{ id: capabilityRevisionId, revision: 1 }],
  id: executorId,
  operationGrants: [{ state: 'allowed' }],
  organizationId,
  privateAssignments: [
    { agentId: null, principalKind: 'user', role: 'admin', userId: actorUserId },
    { agentId, principalKind: 'agent', role: 'use', userId: null },
  ],
  scopeKind: 'private',
  status: 'online',
}

const candidate = {
  agentId,
  actorUserId,
  authorizationRevision: 7,
  capabilityRevisionId,
  consumedAt: null,
  executor: {
    ...executor,
    capabilityRevisions: [{ id: capabilityRevisionId, revision: 1 }],
  },
  executorId,
  expiresAt: new Date('2026-08-12T12:05:00.000Z'),
  operationKeys: ['file.read', 'sandbox.stop', 'workspace.review'],
  runId,
}

const bindingPrisma = (state: { authorizationRevision?: number; consumed?: number }) => {
  let created = false
  const client = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(client),
    $executeRaw: async () => 1,
    agent: {
      findFirst: async () => ({
        toolPolicy: {
          'executor.file.read': true,
          'executor.sandbox.stop': true,
          'executor.workspace.review': true,
        },
      }),
    },
    executor: {
      findUnique: async () => ({
        ...executor,
        authorizationRevision: state.authorizationRevision ?? executor.authorizationRevision,
      }),
      update: async () => ({ nextBindingFence: BigInt(41) }),
    },
    executorAvailabilityCandidate: {
      findUnique: async () => ({
        ...candidate,
        capabilityRevision: { descriptor, id: capabilityRevisionId, reviewStatus: 'active' },
      }),
      updateMany: async () => {
        state.consumed = (state.consumed ?? 0) + 1
        return { count: 1 }
      },
    },
    executorBinding: {
      create: async () => ({
        capabilityRevision: { revision: 1 },
        executorId,
        fence: BigInt(41),
        id: '00000000-0000-4000-8000-000000000007',
      }),
      findUnique: async () => created ? {
        capabilityRevision: { revision: 1 },
        candidateHandleDigest: executorCandidateHandleDigest(handle),
        executorId,
        fence: BigInt(41),
        id: '00000000-0000-4000-8000-000000000007',
      } : null,
      findFirst: async () => null,
    },
    executorCapabilityRevision: {
      findUnique: async () => ({ descriptor, id: capabilityRevisionId, reviewStatus: 'active' }),
    },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
    projectMember: { findFirst: async () => null },
    run: {
      findUnique: async () => ({
        agentId,
        thread: { channel: { organizationId, projectId: null } },
        triggerMessage: { userId: actorUserId },
      }),
    },
    toolRegistryEntry: {
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
    },
  }
  return client as unknown as PrismaClient
}

test('candidate binding pins a run operation and advances a distinct fence', async () => {
  const state: { consumed?: number } = {}
  const result = await bindExecutorCandidate(
    bindingPrisma(state),
    { actorUserId, candidateHandle: handle, operationKey: 'sandbox.stop', runId },
    new Date('2026-08-12T12:00:00.000Z'),
  )

  assert.equal(result.executorId, executorId)
  assert.equal(result.fence, '41')
  assert.equal(state.consumed, 1)
})

test('binding rejects a candidate after its authorization revision changes', async () => {
  await assert.rejects(
    bindExecutorCandidate(
      bindingPrisma({ authorizationRevision: 8 }),
      { actorUserId, candidateHandle: handle, operationKey: 'sandbox.stop', runId },
      new Date('2026-08-12T12:00:00.000Z'),
    ),
    { code: 'EXECUTOR_CANDIDATE_INVALID' },
  )
})

test('a candidate binds an exact operation bundle before one final consume', async () => {
  const state: { consumed?: number } = {}
  const result = await bindExecutorCandidateBundleInTransaction(
    bindingPrisma(state) as unknown as Prisma.TransactionClient,
    {
      actorUserId,
      candidateHandle: handle,
      operationKeys: ['file.read', 'workspace.review'],
      runId,
    },
    new Date('2026-08-12T12:00:00.000Z'),
  )

  assert.deepEqual(result.map((binding) => binding.operationKey), ['file.read', 'workspace.review'])
  assert.equal(state.consumed, 1)
})

test('coding operations reject every partial or mixed executor bundle before candidate consumption', async () => {
  const state: { consumed?: number } = {}
  await assert.rejects(
    bindExecutorCandidateBundleInTransaction(
      bindingPrisma(state) as unknown as Prisma.TransactionClient,
      {
        actorUserId,
        candidateHandle: handle,
        operationKeys: ['coding.launch', 'coding.observe', 'sandbox.stop'],
        runId,
      },
      new Date('2026-08-12T12:00:00.000Z'),
    ),
    { code: 'EXECUTOR_CANDIDATE_INVALID' },
  )
  assert.equal(state.consumed, undefined)
})
