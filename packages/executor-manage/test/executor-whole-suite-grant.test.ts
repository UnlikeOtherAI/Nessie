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
  /** What the agent already holds, which is the revoke set. */
  existingGrantKeys?: readonly string[]
  hasActiveRevision?: boolean
  /**
   * The review status of the LATEST revision. `pending_review` models the case
   * the derivation used to get wrong: a superseded revision keeps its `active`
   * row, so a query filtering on status alone would find one and grant against
   * a policy the daemon no longer honours.
   */
  latestReviewStatus?: string
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
      findMany: async () => (input.existingGrantKeys ?? [])
        .map((operationKey) => ({ operationKey })),
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
            reviewStatus: input.latestReviewStatus ?? 'active',
            revision: 3,
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

test('denying clears every key the agent holds, not just the ones still offered', async () => {
  // The revision narrowed after the grant: it no longer names command.run or
  // mcp.call, but the agent still holds rows for them. Revoking against the
  // live policy would leave those two sitting at `allowed` — dormant while
  // this revision is live, and effective again the day a later revision
  // re-adds the key, with no confirmation and no fresh verification.
  const fake = transactionFake({
    descriptorOperationKeys: ['file.read'],
    existingGrantKeys: ['file.read', 'command.run', 'mcp.call'],
  })
  await setExecutorAgentWholeSuiteGrantInTransaction(fake.tx, actorContext, {
    agentId: AGENT,
    executorId: EXECUTOR,
    state: 'denied',
  })
  assert.deepEqual(
    fake.upserts.map((upsert) => upsert.operationKey).sort(),
    ['command.run', 'file.read', 'mcp.call'],
  )
  assert.ok(fake.upserts.every((upsert) => upsert.state === 'denied'))
  assert.equal(fake.bumps(), 1)
})

test('a revoke still works once the executor has no live policy left', async () => {
  // Disabling an executor's only reviewed revision must never strand a grant
  // with no way to take it back, so the no-live-policy refusal is an ALLOW
  // rule only.
  const fake = transactionFake({
    existingGrantKeys: ['file.read', 'command.run'],
    hasActiveRevision: false,
  })
  await setExecutorAgentWholeSuiteGrantInTransaction(fake.tx, actorContext, {
    agentId: AGENT,
    executorId: EXECUTOR,
    state: 'denied',
  })
  assert.deepEqual(
    fake.upserts.map((upsert) => upsert.operationKey).sort(),
    ['command.run', 'file.read'],
  )
  assert.ok(fake.upserts.every((upsert) => upsert.state === 'denied'))
})

test('a superseded active revision is not the live policy', async () => {
  // The latest revision is awaiting review. An earlier revision keeps its
  // `active` row, and the daemon honours neither — so there is nothing to
  // grant, and the refusal must fire rather than granting the old suite.
  const fake = transactionFake({
    descriptorOperationKeys: ['file.read', 'command.run'],
    latestReviewStatus: 'pending_review',
  })
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

test('revoking nothing is refused rather than bumping the fence', async () => {
  const fake = transactionFake({ existingGrantKeys: [] })
  await assert.rejects(
    () => setExecutorAgentWholeSuiteGrantInTransaction(fake.tx, actorContext, {
      agentId: AGENT,
      executorId: EXECUTOR,
      state: 'denied',
    }),
    (error: unknown) => error instanceof ExecutorError && error.code === 'EXECUTOR_SCOPE_INVALID',
  )
  assert.equal(fake.bumps(), 0)
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
