import assert from 'node:assert/strict'
import test from 'node:test'

import { claimUoaRecoveryAccountLink } from '../src/services/uoa-recovery-link.js'

test('recovery link metadata persists directory entries only', async () => {
  let created: { data: { metadata?: unknown } } | undefined
  const transaction = {
    productAccountLink: {
      create: async (input: { data: { metadata?: unknown } }) => {
        created = input
        return input.data
      },
      findUnique: async () => null,
    },
  }
  const entries = [{
    organizationId: 'uoa-org',
    teamId: 'uoa-team',
    label: 'Engineering',
  }]

  await claimUoaRecoveryAccountLink(transaction as never, {
    identity: {
      organizationId: 'uoa-org',
      subject: 'uoa-subject',
      teamId: 'uoa-team',
      tokenVersion: 7,
    },
    localOrganizationId: '00000000-0000-4000-8000-000000000001',
    returnedTokenVersion: 7,
    subject: 'uoa-subject',
    userId: '00000000-0000-4000-8000-000000000002',
    workspaceDirectory: entries,
  })

  assert.deepEqual(created?.data.metadata, {
    provider: 'uoa',
    workspaceDirectory: entries,
  })
  assert.equal(JSON.stringify(created?.data.metadata).includes('pendingInvites'), false)
})
