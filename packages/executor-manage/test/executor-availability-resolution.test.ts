import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { resolveExecutorAvailabilityCandidates } from '../src/index.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const actorUserId = '00000000-0000-4000-8000-000000000002'
const agentId = '00000000-0000-4000-8000-000000000003'

const actorContext = {
  actor: { actorId: actorUserId, actorType: 'user' as const },
  tenant: { organizationId },
} as never

const descriptor = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  localPolicyDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  operationKeys: ['sandbox.stop'],
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  profiles: ['workspace_sandbox'],
  protocolVersion: 1,
  revision: 1,
}

const availableExecutor = (agentAssigned = true) => ({
  authorizationRevision: 7,
  capabilityRevisions: [{ id: '00000000-0000-4000-8000-000000000004', descriptor, reviewStatus: 'active' }],
  id: '00000000-0000-4000-8000-000000000005',
  operationGrants: [{ operationKey: 'sandbox.stop', state: 'allowed' }],
  privateAssignments: [
    { agentId: null, principalKind: 'user', role: 'admin', userId: actorUserId },
    ...(agentAssigned ? [{ agentId, principalKind: 'agent', role: 'use', userId: null }] : []),
  ],
  projectId: null,
  scopeKind: 'private',
  status: 'online',
})

const availabilityPrisma = (
  executor: ReturnType<typeof availableExecutor>,
  created: Array<Record<string, unknown>>,
): PrismaClient => ({
  agent: {
    findFirst: async () => ({
      id: agentId,
      toolPolicy: { 'executor.sandbox.stop': true },
    }),
  },
  executor: { findMany: async () => [executor] },
  executorAvailabilityCandidate: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data)
      return data
    },
    deleteMany: async () => ({ count: 0 }),
  },
  organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
  toolRegistryEntry: {
    upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
      id: where.organizationId_scopeKey_toolId.toolId,
    }),
  },
} as unknown as PrismaClient)

test('availability returns an opaque candidate only after every private gate agrees', async () => {
  const persisted: Array<Record<string, unknown>> = []
  const response = await resolveExecutorAvailabilityCandidates(
    availabilityPrisma(availableExecutor(), persisted),
    actorContext,
    { agentId, operationKeys: ['sandbox.stop'] },
    new Date('2026-08-12T12:00:00.000Z'),
  )

  assert.equal(response.explanations.length, 0)
  assert.equal(response.candidates.length, 1)
  assert.deepEqual(response.candidates[0]?.operationKeys, ['sandbox.stop'])
  assert.equal('executorId' in response.candidates[0]!, false)
  assert.match(response.candidates[0]!.handle, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(persisted[0]?.executorId, availableExecutor().id)
  assert.equal(persisted[0]?.handleDigest?.toString().startsWith('sha256:'), true)
})

test('private availability fails closed when the exact agent assignment is absent', async () => {
  const response = await resolveExecutorAvailabilityCandidates(
    availabilityPrisma(availableExecutor(false), []),
    actorContext,
    { agentId, operationKeys: ['sandbox.stop'] },
  )

  assert.deepEqual(response.candidates, [])
  assert.deepEqual(response.explanations, [{ readiness: 'unavailable', reason: 'scope_mismatch' }])
})
