import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { UoaAutomaticMembershipAdapter } from '@nessie/team-admin'
import { provisionAutomaticMembershipWithAdapter } from '../src/services/automatic-membership-login.js'

const activeRule = {
  claim: { domain: 'example.test' },
  generation: 1,
  id: 'rule-1',
  organization: { externalOrgId: 'uoa-org-1' },
  organizationId: 'org-1',
  targets: [{ team: { externalTeamId: 'uoa-team-1' }, teamId: 'team-1' }],
  uoaFenceToken: 'fence-1',
  updatedAt: new Date(),
}

const adapter = (overrides: Partial<UoaAutomaticMembershipAdapter> = {}): UoaAutomaticMembershipAdapter => ({
  assertRuleAdministrator: async () => true,
  attestVerifiedDomain: async ({ domain, uoaSub }) => ({
    assertedAt: new Date(),
    domain,
    expiresAt: new Date(Date.now() + 60_000),
    uoaSub,
  }),
  getOperation: async () => ({ operationId: 'operation-1', status: 'accepted' }),
  grantMember: async () => ({ operationId: 'operation-1', status: 'accepted' }),
  listTeams: async () => [],
  listVerifiedDomainSubjects: async () => ({ cursor: null, snapshotId: 'snapshot-1', subjects: [] }),
  setRuleFence: async () => undefined,
  ...overrides,
})

test('login provisioning is bounded and turns a UOA attestation outage into no automatic grant', async () => {
  const prisma = {
    automaticMembershipRule: { findMany: async () => [activeRule] },
  } as unknown as PrismaClient

  const grants = await provisionAutomaticMembershipWithAdapter(prisma, 'subject-1', adapter({
    attestVerifiedDomain: async () => { throw new Error('UOA unavailable') },
  }))

  assert.deepEqual(grants, [])
})

test('login provisioning passes a member-only deterministic UOA grant key without changing session context', async () => {
  const grantInputs: Array<Parameters<UoaAutomaticMembershipAdapter['grantMember']>[0]> = []
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      automaticMembershipGrant: { update: async () => undefined },
    }),
    automaticMembershipGrant: {
      upsert: async () => ({ id: 'grant-1', outcome: 'pending' }),
    },
    automaticMembershipRule: { findMany: async () => [activeRule] },
  } as unknown as PrismaClient

  const grants = await provisionAutomaticMembershipWithAdapter(prisma, 'subject-1', adapter({
    grantMember: async (input) => {
      grantInputs.push(input)
      return { operationId: 'operation-1', status: 'accepted' }
    },
  }))

  assert.deepEqual(grants, [])
  assert.equal(grantInputs.length, 1)
  assert.deepEqual(grantInputs[0], {
    domain: 'example.test',
    externalOrgId: 'uoa-org-1',
    externalTeamId: 'uoa-team-1',
    fenceToken: 'fence-1',
    idempotencyKey: 'automatic-membership:login:rule-1:team-1:subject-1:1',
    lifecycleRevision: 1,
    ruleGeneration: 1,
    ruleId: 'rule-1',
    uoaSub: 'subject-1',
  })
})
