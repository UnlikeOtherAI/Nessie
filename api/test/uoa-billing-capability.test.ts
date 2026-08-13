import assert from 'node:assert/strict'
import test from 'node:test'

import { billingCreditsV1ConformanceFixture } from '@unlikeotherai/billing-statement-protocol'

import {
  capabilityFromUoaCredits,
  getUoaBillingCapability,
} from '../src/services/uoa-billing-capability.js'
import {
  actorContext,
  env,
  prisma,
} from './uoa-billing-statement-fixtures.js'

const credits = (role: 'billing_manager' | 'member') => ({
  ...billingCreditsV1ConformanceFixture,
  storefront: { ...billingCreditsV1ConformanceFixture.storefront, identifier: 'nessie' },
  subject: {
    user_id: 'uoa-user',
    organisation_id: 'uoa-org',
    team_id: 'uoa-team',
  },
  viewer: {
    ...billingCreditsV1ConformanceFixture.viewer,
    role,
  },
})

test('UOA billing role wins over the local OrganizationMember role', async () => {
  const response = credits('billing_manager')
  const capability = await getUoaBillingCapability(
    prisma() as never,
    { ...actorContext, actor: { ...actorContext.actor, roles: ['member'] } } as never,
    { env, fetchImpl: (async () => new Response(JSON.stringify(response))) as typeof fetch },
  )
  assert.equal(capability.canManageBilling, true)
  assert.equal(capability.canReadStatement, true)
  assert.equal(capability.scope.teamId, 'uoa-team')
})

test('a local owner receives no management capability when UOA makes them a member', () => {
  const capability = capabilityFromUoaCredits(
    {
      subject: {
        user_id: 'uoa-user',
        organisation_id: 'uoa-org',
        team_id: 'uoa-team-b',
      },
      viewer: { role: 'member' },
    } as never,
    7,
  )
  assert.equal(capability.canManageBilling, false)
  assert.equal(capability.canReadStatement, false)
  assert.equal(capability.scope.teamId, 'uoa-team-b')
})
