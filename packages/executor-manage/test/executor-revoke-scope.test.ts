import assert from 'node:assert/strict'
import test from 'node:test'

import { executorOperationKeysHeldElsewhere } from '../src/executor-access-mutations.js'

/**
 * The regression this pins.
 *
 * The logical executor tool policy is ORGANISATION-wide — one
 * `executor.<operation>` registry entry, never a per-machine projection — while
 * the grant row is the per-machine half. The binding gate reads the policy
 * entry with no executor dimension.
 *
 * So when a person withdraws consent for ONE machine, the confirm route must
 * not switch that shared entry off for operations the agent still holds
 * elsewhere. Before this, revoking an agent's whole-suite grant on a laptop
 * disabled every executor tool the agent held and cut it off the server it was
 * still legitimately granted on. Recovery needed a fresh prepare, confirm and
 * password on the other machine.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const AGENT = '44444444-4444-4444-8444-444444444444'
const REVOKED = '55555555-5555-4555-8555-555555555555'
const OTHER = '66666666-6666-4666-8666-666666666666'

type GrantRow = {
  agentId: string
  executorId: string
  operationKey: string
  organizationId: string
  state: string
}

const prismaFake = (rows: GrantRow[]) => {
  const seen: unknown[] = []
  const prisma = {
    executorAgentOperationGrant: {
      findMany: async (args: {
        where: {
          agentId: string
          executorId: { not: string }
          state: string
          executor: { organizationId: string }
        }
      }) => {
        seen.push(args.where)
        return rows
          .filter((row) =>
            row.agentId === args.where.agentId
            && row.executorId !== args.where.executorId.not
            && row.state === args.where.state
            && row.organizationId === args.where.executor.organizationId)
          .map((row) => ({ operationKey: row.operationKey }))
      },
    },
  }
  return { prisma: prisma as never, where: () => seen[0] }
}

const grant = (executorId: string, operationKey: string, state = 'allowed'): GrantRow => ({
  agentId: AGENT,
  executorId,
  operationKey,
  organizationId: ORG,
  state,
})

test('an operation still held on another executor is reported as held', async () => {
  const fake = prismaFake([
    grant(REVOKED, 'file.read'),
    grant(REVOKED, 'command.run'),
    grant(OTHER, 'file.read'),
  ])
  const held = await executorOperationKeysHeldElsewhere(fake.prisma, {
    agentId: AGENT,
    excludeExecutorId: REVOKED,
    organizationId: ORG,
  })
  // file.read survives the revoke because the other machine still grants it;
  // command.run does not, so its shared policy entry may be switched off.
  assert.deepEqual([...held].sort(), ['file.read'])
})

test('the executor being revoked is excluded, since its rows are cleared after', async () => {
  // The confirm route writes the policy half BEFORE the grant rows are
  // cleared, so the revoked executor is still holding `allowed` rows here.
  // Counting it would make every revoke look like "held elsewhere" and the
  // policy would never be switched off at all.
  const fake = prismaFake([grant(REVOKED, 'file.read'), grant(REVOKED, 'command.run')])
  const held = await executorOperationKeysHeldElsewhere(fake.prisma, {
    agentId: AGENT,
    excludeExecutorId: REVOKED,
    organizationId: ORG,
  })
  assert.equal(held.size, 0)
  assert.deepEqual(fake.where(), {
    agentId: AGENT,
    executorId: { not: REVOKED },
    state: 'allowed',
    executor: { organizationId: ORG },
  })
})

test('a denied row elsewhere does not keep the shared policy alive', async () => {
  const fake = prismaFake([grant(REVOKED, 'file.read'), grant(OTHER, 'file.read', 'denied')])
  const held = await executorOperationKeysHeldElsewhere(fake.prisma, {
    agentId: AGENT,
    excludeExecutorId: REVOKED,
    organizationId: ORG,
  })
  assert.equal(held.size, 0)
})

test('another organisation never keeps this one’s policy alive', async () => {
  const foreign = { ...grant(OTHER, 'file.read'), organizationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
  const fake = prismaFake([grant(REVOKED, 'file.read'), foreign])
  const held = await executorOperationKeysHeldElsewhere(fake.prisma, {
    agentId: AGENT,
    excludeExecutorId: REVOKED,
    organizationId: ORG,
  })
  assert.equal(held.size, 0)
})
