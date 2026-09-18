import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

import {
  IMPLEMENTED_EXECUTOR_OPERATION_KEYS,
  executorWholeSuiteOperationKeys,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { ExecutorError } from '../src/executor-errors.js'
import {
  requiresFreshExecutorVerification,
  setExecutorAgentWholeSuiteGrantInTransaction,
} from '../src/index.js'

/**
 * "If an agent has access to an executor, it has the whole suite available on
 * that executor."
 *
 * The rule is enforced by construction: the prepared change carries no
 * operation key, so the set is derived from the revision a person reviewed.
 * These cases pin the derivation — every key the active revision names, kept
 * to the implemented catalog, minus `workspace.promote`, whose daemon path is
 * real but which is deliberately absent from the model-facing toolset because
 * only a person may issue a reviewed promotion.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const AGENT = '44444444-4444-4444-8444-444444444444'
const EXECUTOR = '55555555-5555-4555-8555-555555555555'

const actorContext = {
  actionContext: {},
  actor: { actorId: USER, actorType: 'user' },
  tenant: { organizationId: ORG },
} as unknown as AuthorizedActionContext

type Upsert = { agentId: string; operationKey: string; state: string }

const transactionFake = (input: {
  descriptorOperationKeys?: readonly string[]
  hasActiveRevision?: boolean
}) => {
  const upserts: Upsert[] = []
  let bumps = 0
  const tx = {
    executor: {
      findFirst: async () => ({
        authorizationRevision: 4,
        id: EXECUTOR,
        organizationId: ORG,
        projectId: null,
        scopeKind: 'organization',
      }),
      update: async () => {
        bumps += 1
        return { authorizationRevision: 5 }
      },
    },
    executorAgentOperationGrant: {
      upsert: async (args: {
        create: { agentId: string; operationKey: string; state: string }
      }) => {
        upserts.push({
          agentId: args.create.agentId,
          operationKey: args.create.operationKey,
          state: args.create.state,
        })
      },
    },
    executorCapabilityRevision: {
      findFirst: async () => (input.hasActiveRevision === false
        ? null
        : {
            descriptor: {
              limits: {
                maxCommandRuntimeSeconds: 60,
                maxResultBytes: 65_536,
                maxSessions: 1,
              },
              localPolicyDigest: `sha256:${'a'.repeat(64)}`,
              operationKeys: input.descriptorOperationKeys ?? [],
              platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
              profiles: ['workspace_sandbox'],
              protocolVersion: 1,
              revision: 3,
              sandboxBackend: 'virtualization_framework',
              supervisor: 'desktop',
            },
          }),
    },
    executorPrivateAssignment: { findFirst: async () => null },
    executorSession: { updateMany: async () => ({ count: 0 }) },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'owner' }),
    },
    projectMember: { findUnique: async () => null },
  }
  return { bumps: () => bumps, tx: tx as unknown as Prisma.TransactionClient, upserts }
}

test('the derived suite is every offered key except the human-only one', () => {
  assert.deepEqual(
    executorWholeSuiteOperationKeys([...IMPLEMENTED_EXECUTOR_OPERATION_KEYS]),
    IMPLEMENTED_EXECUTOR_OPERATION_KEYS.filter((key) => key !== 'workspace.promote'),
  )
  // A key the revision does not name is not granted, and a key outside the
  // implemented catalog cannot creep in through the descriptor.
  assert.deepEqual(
    executorWholeSuiteOperationKeys(['file.read', 'coding.attach', 'workspace.promote']),
    ['file.read'],
  )
})

test('applying the grant writes exactly the active revision\u2019s suite', async () => {
  const fake = transactionFake({
    descriptorOperationKeys: [
      'file.list', 'file.read', 'file.write', 'command.run', 'workspace.review',
      'workspace.promote', 'mcp.tools', 'mcp.call',
    ],
  })
  const revision = await setExecutorAgentWholeSuiteGrantInTransaction(fake.tx, actorContext, {
    agentId: AGENT,
    executorId: EXECUTOR,
    state: 'allowed',
  })

  assert.equal(revision, 5)
  assert.deepEqual(
    fake.upserts.map((upsert) => upsert.operationKey),
    ['file.list', 'file.read', 'file.write', 'command.run', 'workspace.review', 'mcp.tools', 'mcp.call'],
  )
  assert.ok(
    !fake.upserts.some((upsert) => upsert.operationKey === 'workspace.promote'),
    'only a person can issue a reviewed promotion, so it is never in an agent\u2019s suite',
  )
  assert.ok(fake.upserts.every((upsert) => upsert.state === 'allowed' && upsert.agentId === AGENT))
  // One authorization bump for the whole suite: the fence is the grant, not
  // each key, and per-key bumps would churn the daemon's connection epoch.
  assert.equal(fake.bumps(), 1)
})

test('denying covers the same suite rather than leaving a stale allow', async () => {
  const fake = transactionFake({
    descriptorOperationKeys: ['file.read', 'command.run', 'workspace.promote'],
  })
  await setExecutorAgentWholeSuiteGrantInTransaction(fake.tx, actorContext, {
    agentId: AGENT,
    executorId: EXECUTOR,
    state: 'denied',
  })
  assert.deepEqual(
    fake.upserts.map((upsert) => upsert.operationKey),
    ['file.read', 'command.run'],
  )
  assert.ok(fake.upserts.every((upsert) => upsert.state === 'denied'))
})

test('an executor with no active reviewed policy grants nothing at all', async () => {
  const fake = transactionFake({ hasActiveRevision: false })
  await assert.rejects(
    () => setExecutorAgentWholeSuiteGrantInTransaction(fake.tx, actorContext, {
      agentId: AGENT,
      executorId: EXECUTOR,
      state: 'allowed',
    }),
    (error: unknown) => error instanceof ExecutorError && error.code === 'EXECUTOR_SCOPE_INVALID',
  )
  assert.equal(fake.upserts.length, 0)
  assert.equal(fake.bumps(), 0)
})

test('a whole-suite allow re-proves the human, exactly as one operation does', () => {
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_executor_grant', agentId: AGENT, state: 'allowed',
  }), true)
  assert.equal(requiresFreshExecutorVerification({
    kind: 'agent_executor_grant', agentId: AGENT, state: 'denied',
  }), false)
})
