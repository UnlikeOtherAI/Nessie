import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { alertAutomaticMembershipHealth } from '../src/control/automatic-membership/health-alert.js'

test('a rejected automatic-membership grant creates one unread alert per live repairer', async () => {
  let recorded: { data: unknown[]; skipDuplicates: boolean } | null = null
  const prisma = {
    organizationMember: {
      findMany: async () => [{ userId: 'owner-1' }, { userId: 'admin-1' }],
    },
    userAlert: {
      createMany: async (input: { data: unknown[]; skipDuplicates: boolean }) => {
        recorded = input
        return { count: 2 }
      },
    },
  } as unknown as PrismaClient

  const created = await alertAutomaticMembershipHealth(prisma, {
    healthRevision: 7,
    organizationId: 'organization-1',
    reason: 'The authorizing administrator no longer has access.',
    ruleId: 'rule-1',
    teamName: 'Research',
  })

  assert.equal(created, 2)
  assert.ok(recorded)
  assert.equal(recorded.skipDuplicates, true)
  assert.deepEqual(recorded.data, [
    {
      automaticMembershipRuleId: 'rule-1',
      eventKey: 'automatic-membership:rule:rule-1:7',
      kind: 'automatic_membership_health',
      metadata: {
        reason: 'The authorizing administrator no longer has access.',
        ruleId: 'rule-1',
        teamName: 'Research',
      },
      organizationId: 'organization-1',
      userId: 'owner-1',
    },
    {
      automaticMembershipRuleId: 'rule-1',
      eventKey: 'automatic-membership:rule:rule-1:7',
      kind: 'automatic_membership_health',
      metadata: {
        reason: 'The authorizing administrator no longer has access.',
        ruleId: 'rule-1',
        teamName: 'Research',
      },
      organizationId: 'organization-1',
      userId: 'admin-1',
    },
  ])
})
