import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { canonicalExecutorJson } from '@nessie/schemas'

import {
  assertExecutorCommandBindingCurrent,
  createExecutorCommand,
  pollExecutorCommand,
  readExecutorCommandResult,
  recordExecutorCommandReceipt,
} from '../src/index.js'

const commandId = '00000000-0000-4000-8000-000000000001'
const bindingId = '00000000-0000-4000-8000-000000000002'
const executorId = '00000000-0000-4000-8000-000000000003'
const queueJobId = '00000000-0000-4000-8000-000000000004'
const toolCallId = '00000000-0000-4000-8000-000000000005'
const organizationId = '00000000-0000-4000-8000-000000000006'
const capabilityRevisionId = '00000000-0000-4000-8000-000000000007'
const secret = 'command-encryption-secret'

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

test('command payload and terminal result are encrypted at rest and receipt transitions are ordered', async () => {
  const state: Record<string, unknown> = {
    binding: {
      capabilityRevision: { revision: 1 },
      fence: BigInt(7),
      operationKey: 'sandbox.stop',
    },
    payloadExpiresAt: new Date('2026-08-12T12:05:00.000Z'),
    queueJob: { status: 'processing' },
    state: 'leased',
  }
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data)
        return data
      },
      findFirst: async () => state,
      findUnique: async () => ({ ...state, binding: { executorId } }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data)
        return state
      },
    },
  } as unknown as PrismaClient
  const payload = { requestedBy: 'agent', stopReason: 'user_cancelled' }
  await createExecutorCommand(prisma, {
    bindingId,
    commandId,
    encryptionSecret: secret,
    expiresAt: state.payloadExpiresAt as Date,
    payload,
    queueJobId,
    toolCallId,
  })

  assert.equal((state.deliveryPayloadCiphertext as string).includes('user_cancelled'), false)
  const envelope = await pollExecutorCommand(
    prisma,
    secret,
    executorId,
    new Date('2026-08-12T12:00:00.000Z'),
  )
  assert.deepEqual(envelope?.payload, payload)
  assert.equal(envelope?.bindingFence, '7')

  const at = '2026-08-12T12:00:01.000Z'
  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: at,
    state: 'accepted',
  }, undefined)
  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: at,
    state: 'started',
  }, undefined)
  const result = { status: 'no_active_sandbox', success: true }
  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: at,
    resultDigest: digest(result),
    state: 'result_acknowledged',
  }, result)

  assert.equal((state.resultCiphertext as string).includes('no_active_sandbox'), false)
  assert.deepEqual(await readExecutorCommandResult(prisma, secret, commandId), result)
})

test('a terminal command receipt cannot be replaced by a different result', async () => {
  const state = {
    binding: { executorId },
    resultDigest: digest({ success: true }),
    state: 'result_acknowledged',
  }
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: { findUnique: async () => state },
  } as unknown as PrismaClient
  await assert.rejects(
    recordExecutorCommandReceipt(prisma, secret, executorId, {
      commandId,
      occurredAt: '2026-08-12T12:00:01.000Z',
      resultDigest: digest({ success: false }),
      state: 'result_acknowledged',
    }, { success: false }),
    { code: 'EXECUTOR_COMMAND_REPLAY' },
  )
})

test('a late terminal receipt can resolve an unknown outcome without changing its digest', async () => {
  const result = { success: true }
  const state: Record<string, unknown> = {
    binding: { executorId },
    state: 'unknown_outcome',
  }
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: {
      findUnique: async () => state,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data)
        return state
      },
    },
  } as unknown as PrismaClient

  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: '2026-08-12T12:00:01.000Z',
    resultDigest: digest(result),
    state: 'result_acknowledged',
  }, result)

  assert.equal(state.state, 'result_acknowledged')
  assert.equal(state.resultDigest, digest(result))
})

const currentBindingPrisma = (agentAssigned: boolean): PrismaClient => {
  const candidate = {
    actorUserId: '00000000-0000-4000-8000-000000000006',
    agentId: '00000000-0000-4000-8000-000000000007',
    authorizationRevision: 3,
    executorId,
    runId: null,
  }
  const client = {
    $executeRaw: async () => 1,
    agent: {
      findFirst: async () => ({ toolPolicy: { 'executor.sandbox.stop': true } }),
    },
    executor: {
      findUnique: async () => ({
        authorizationRevision: 3,
        capabilityRevisions: [{ id: capabilityRevisionId }],
        id: executorId,
        operationGrants: [{ state: 'allowed' }],
        organizationId: organizationId,
        privateAssignments: [
          { agentId: null, principalKind: 'user', role: 'admin', userId: candidate.actorUserId },
          ...(agentAssigned
            ? [{ agentId: candidate.agentId, principalKind: 'agent', role: 'use', userId: null }]
            : []),
        ],
        projectId: null,
        scopeKind: 'private',
        status: 'online',
      }),
    },
    executorAvailabilityCandidate: { findUnique: async () => candidate },
    executorBinding: {
      findUnique: async () => ({
        authorizationRevision: 3,
        candidateHandleDigest: 'sha256:binding-provenance',
        capabilityRevisionId,
        executorId,
        operationKey: 'sandbox.stop',
        runId: '00000000-0000-4000-8000-000000000008',
      }),
    },
    executorCapabilityRevision: {
      findUnique: async () => ({ descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        localPolicyDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        operationKeys: ['sandbox.stop'],
        platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
        profiles: ['workspace_sandbox'],
        protocolVersion: 1,
        revision: 1,
      }, reviewStatus: 'active' }),
    },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
    run: {
      findUnique: async () => ({
        agentId: candidate.agentId,
        thread: { channel: { organizationId, projectId: null } },
        triggerMessage: { userId: candidate.actorUserId },
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

test('dispatch rechecks the private user and agent assignments held by a binding', async () => {
  await assert.doesNotReject(
    assertExecutorCommandBindingCurrent(
      currentBindingPrisma(true) as never,
      bindingId,
    ),
  )
  await assert.rejects(
    assertExecutorCommandBindingCurrent(
      currentBindingPrisma(false) as never,
      bindingId,
    ),
    { code: 'EXECUTOR_BINDING_FENCED' },
  )
})
