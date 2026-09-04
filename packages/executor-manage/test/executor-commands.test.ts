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
  waitForExecutorCommandResult,
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
    executorBinding: {
      findUnique: async () => ({
        authorizationRevision: 3,
        candidateHandleDigest: 'sha256:binding-provenance',
        capabilityRevisionId,
        executorId,
        operationKey: 'sandbox.stop',
        runId: '00000000-0000-4000-8000-000000000008',
        sessionId: null,
        session: null,
      }),
    },
    executorAvailabilityCandidate: {
      findUnique: async () => ({
        actorUserId: '00000000-0000-4000-8000-000000000006',
        agentId: '00000000-0000-4000-8000-000000000007',
        authorizationRevision: 3,
        executorId,
        runId: null,
      }),
    },
    executor: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({
        authorizationRevision: 3,
        capabilityRevisions: [{ id: capabilityRevisionId }],
        id: executorId,
        operationGrants: [{ state: 'allowed' }],
        organizationId,
        privateAssignments: [
          { agentId: null, principalKind: 'user', role: 'admin', userId: '00000000-0000-4000-8000-000000000006' },
          { agentId: '00000000-0000-4000-8000-000000000007', principalKind: 'agent', role: 'use', userId: null },
        ],
        projectId: null,
        scopeKind: 'private',
        status: 'online',
        lastSeenAt: new Date(),
      }),
    },
    executorCapabilityRevision: {
      findUnique: async () => ({ descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        localPolicyDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        operationKeys: ['sandbox.stop'],
        platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
        sandboxBackend: 'virtualization_framework',
        supervisor: 'desktop',
        profiles: ['workspace_sandbox'],
        protocolVersion: 1,
        revision: 1,
      }, reviewStatus: 'active' }),
    },
    organizationMember: { findUnique: async () => ({ deactivatedAt: null }) },
    agent: { findFirst: async () => ({ toolPolicy: { 'executor.sandbox.stop': true } }) },
    run: {
      findUnique: async () => ({
        agentId: '00000000-0000-4000-8000-000000000007',
        thread: { channel: { organizationId, projectId: null } },
        triggerMessage: { userId: '00000000-0000-4000-8000-000000000006' },
      }),
    },
    toolRegistryEntry: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ where }: { where: { organizationId_scopeKey_toolId: { toolId: string } } }) => ({
        id: where.organizationId_scopeKey_toolId.toolId,
      }),
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

test('a terminal receipt that wins the timeout lock is returned instead of unknown', async () => {
  const result = { success: true }
  const state: Record<string, unknown> = {
    binding: { executorId, operationKey: 'sandbox.stop', sessionId: null },
    state: 'started',
  }
  let releaseLock: (() => void) | undefined
  let queuedLock = Promise.resolve()
  let releaseUpdate!: () => void
  const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve })
  let updateEntered!: () => void
  const updateStarted = new Promise<void>((resolve) => { updateEntered = resolve })
  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      let transactionRelease: (() => void) | undefined
      const tx = {
        $executeRaw: async () => {
          if (transactionRelease) return 1
          const prior = queuedLock
          const held = new Promise<void>((resolve) => { releaseLock = resolve })
          queuedLock = prior.then(() => held)
          await prior
          transactionRelease = releaseLock
          return 1
        },
        executorCommand: {
          findUnique: async () => state,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updateEntered()
            await updateReleased
            Object.assign(state, data)
            return state
          },
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            if (['leased', 'accepted', 'started'].includes(String(state.state))) {
              Object.assign(state, data)
              return { count: 1 }
            }
            return { count: 0 }
          },
        },
      }
      try {
        return await callback(tx)
      } finally {
        transactionRelease?.()
      }
    },
  } as unknown as PrismaClient

  const receipt = recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: '2026-08-12T12:00:01.000Z',
    resultDigest: digest(result),
    state: 'result_acknowledged',
  }, result)
  await updateStarted
  const wait = waitForExecutorCommandResult(
    prisma,
    secret,
    commandId,
    new Date('2000-01-01T00:00:00.000Z'),
  )

  releaseUpdate()
  await receipt
  assert.deepEqual(await wait, result)
  assert.equal(state.state, 'result_acknowledged')
})

test('a failed browser receipt terminalizes only its exact active session', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000009'
  const state = {
    binding: {
      executorId,
      operationKey: 'browser.open',
      session: { profile: 'workspace_sandbox' },
      sessionId,
    },
    id: commandId,
    state: 'started',
  }
  let terminalState: string | undefined
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: {
      findUnique: async () => state,
      update: async () => state,
    },
    executorSession: {
      updateMany: async ({ data, where }: {
        data: { status: string }
        where: { executorId: string; id: string; status: { in: string[] } }
      }) => {
        assert.deepEqual(where, {
          executorId,
          id: sessionId,
          status: { in: ['pending', 'active'] },
        })
        terminalState = data.status
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  const result = { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }

  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: '2026-08-12T12:00:01.000Z',
    resultDigest: digest(result),
    state: 'result_acknowledged',
  }, result)

  assert.equal(terminalState, 'failed')
})

test('an exited coding receipt moves only its exact session to attention', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000010'
  const state = {
    binding: {
      executorId,
      operationKey: 'coding.observe',
      session: { profile: 'coding_session' },
      sessionId,
    },
    id: commandId,
    state: 'started',
  }
  let terminalState: string | undefined
  const prisma = {
    $executeRaw: async () => 1,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
    executorCommand: {
      findUnique: async () => state,
      update: async () => state,
    },
    executorSession: {
      updateMany: async ({ data, where }: {
        data: { status: string }
        where: { executorId: string; id: string; status: { in: string[] } }
      }) => {
        assert.deepEqual(where, { executorId, id: sessionId, status: { in: ['active'] } })
        terminalState = data.status
        return { count: 1 }
      },
    },
  } as unknown as PrismaClient
  const result = { agent: 'codex', lifecycle: 'exited', success: true }

  await recordExecutorCommandReceipt(prisma, secret, executorId, {
    commandId,
    occurredAt: '2026-08-12T12:00:01.000Z',
    resultDigest: digest(result),
    state: 'result_acknowledged',
  }, result)

  assert.equal(terminalState, 'attention')
})

const currentBindingPrisma = (
  agentAssigned: boolean,
  operationKey: 'browser.open' | 'coding.launch' | 'sandbox.stop' | 'workspace.review' = 'sandbox.stop',
  sessionStatus: 'active' | 'pending' | 'stopped' = 'active',
): PrismaClient => {
  const sessionId = operationKey === 'browser.open' || operationKey === 'coding.launch'
    ? '00000000-0000-4000-8000-000000000009'
    : null
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
      findFirst: async () => ({ toolPolicy: { [`executor.${operationKey}`]: true } }),
    },
    executor: {
      updateMany: async () => ({ count: 0 }),
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
        lastSeenAt: new Date(),
      }),
    },
    executorAvailabilityCandidate: { findUnique: async () => candidate },
    executorBinding: {
      findUnique: async () => ({
        authorizationRevision: 3,
        candidateHandleDigest: 'sha256:binding-provenance',
        capabilityRevisionId,
        executorId,
        operationKey,
        runId: '00000000-0000-4000-8000-000000000008',
        sessionId,
        session: sessionId
          ? {
            executorId,
            profile: operationKey === 'coding.launch' ? 'coding_session' : 'workspace_sandbox',
            runId: '00000000-0000-4000-8000-000000000008',
            status: sessionStatus,
            }
          : null,
      }),
    },
    executorCapabilityRevision: {
      findUnique: async () => ({ descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        localPolicyDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        operationKeys: [operationKey],
        platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
        sandboxBackend: 'virtualization_framework',
        supervisor: 'desktop',
        profiles: operationKey === 'coding.launch'
          ? ['workspace_sandbox', 'coding_session']
          : ['workspace_sandbox'],
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
      deleteMany: async () => ({ count: 0 }),
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

test('an ordinary workspace review does not require a coding session', async () => {
  await assert.doesNotReject(
    assertExecutorCommandBindingCurrent(
      currentBindingPrisma(true, 'workspace.review') as never,
      bindingId,
    ),
  )
})

test('delivery fences a browser command after its session is stopped', async () => {
  const client = currentBindingPrisma(true, 'browser.open') as unknown as {
    executorBinding: { findUnique: () => Promise<Record<string, unknown>> }
  }
  const original = client.executorBinding.findUnique
  let reads = 0
  client.executorBinding.findUnique = async () => ({
    ...(await original()),
    session: {
      executorId,
      profile: 'workspace_sandbox',
      runId: '00000000-0000-4000-8000-000000000008',
      status: ++reads === 1 ? 'active' : 'stopped',
    },
  })
  await assert.rejects(
    assertExecutorCommandBindingCurrent(client as unknown as never, bindingId),
    { code: 'EXECUTOR_BINDING_FENCED' },
  )
  assert.equal(reads, 2)
})

test('only browser.open can consume its own pending browser session', async () => {
  const client = currentBindingPrisma(true, 'browser.open', 'pending') as never
  await assert.rejects(
    assertExecutorCommandBindingCurrent(client, bindingId),
    { code: 'EXECUTOR_BINDING_FENCED' },
  )
  await assert.doesNotReject(
    assertExecutorCommandBindingCurrent(client, bindingId, { allowPendingBrowserOpen: true }),
  )
})

test('only coding.launch can consume its own pending coding session', async () => {
  const client = currentBindingPrisma(true, 'coding.launch', 'pending') as never
  await assert.rejects(
    assertExecutorCommandBindingCurrent(client, bindingId),
    { code: 'EXECUTOR_BINDING_FENCED' },
  )
  await assert.doesNotReject(
    assertExecutorCommandBindingCurrent(client, bindingId, { allowPendingCodingLaunch: true }),
  )
})
