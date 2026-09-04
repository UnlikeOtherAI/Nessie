import test from 'node:test'
import assert from 'node:assert/strict'

test('automatic membership worker has no local membership authority', async () => {
  const { sweepAutomaticMembershipBackfills } = await import('./automatic-membership-backfill.js')
  let queried = false
  await sweepAutomaticMembershipBackfills({
    automaticMembershipBackfillRun: { findMany: async () => { queried = true; return [] } },
  } as never, {
    setRuleFence: async () => {},
    assertRuleAdministrator: async () => true,
    listVerifiedDomainSubjects: async () => ({ snapshotId: 'snapshot', subjects: [], cursor: null }),
    grantMember: async () => ({ operationId: 'operation', status: 'completed' }),
    getOperation: async () => ({ operationId: 'operation', status: 'completed' }),
  })
  assert.equal(queried, false)
})
