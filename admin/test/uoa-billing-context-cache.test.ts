import assert from 'node:assert/strict'
import test from 'node:test'

import { QueryClient } from '@tanstack/react-query'

import {
  billingCreditsKey,
  billingStatementKey,
} from '../src/facades/billing/hooks.js'

const teamA = {
  organisationId: 'uoa-org',
  teamId: 'uoa-team-a',
  tokenVersion: 7,
  userId: 'uoa-user',
}
const teamB = {
  ...teamA,
  teamId: 'uoa-team-b',
}

test('switching the active UOA team cannot reuse a manager billing projection', () => {
  const queryClient = new QueryClient()
  const managerCredits = { viewer: { role: 'billing_manager' } }
  queryClient.setQueryData(billingCreditsKey(teamA), managerCredits)

  assert.deepEqual(queryClient.getQueryData(billingCreditsKey(teamA)), managerCredits)
  assert.equal(queryClient.getQueryData(billingCreditsKey(teamB)), undefined)
  assert.notDeepEqual(billingStatementKey(teamA), billingStatementKey(teamB))
})

test('the credential epoch is part of every exact UOA billing cache key', () => {
  assert.notDeepEqual(
    billingCreditsKey(teamA),
    billingCreditsKey({ ...teamA, tokenVersion: 8 }),
  )
})
