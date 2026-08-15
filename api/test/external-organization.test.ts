import assert from 'node:assert/strict'
import test from 'node:test'

import {
  externalOrganizationPlaceholderName,
  syncExternalOrganizationNames,
} from '../src/services/external-organization.js'

test('the placeholder name derives from the first 8 chars of the external org id', () => {
  assert.equal(
    externalOrganizationPlaceholderName('uoa-org-1234'),
    'Organisation uoa-org-',
  )
})

test('the name mirror rewrites only directory entries that carry an orgName', async () => {
  const writes: Array<{ where: unknown; data: unknown }> = []
  const prisma = {
    organization: {
      updateMany: async (input: { where: unknown; data: unknown }) => {
        writes.push(input)
        return { count: 1 }
      },
    },
  }

  await syncExternalOrganizationNames(prisma as never, [
    { organizationId: 'org-a', teamId: 't1', label: 'Team 1', orgName: 'Acme' },
    // Second workspace of the same org: one write, the latest name wins.
    { organizationId: 'org-a', teamId: 't2', label: 'Team 2', orgName: 'Acme Corp' },
    // No orgName asserted → the local mirror is left alone, never blanked.
    { organizationId: 'org-b', teamId: 't3', label: 'Team 3' },
  ])

  assert.deepEqual(writes, [{
    where: { externalOrgId: 'org-a', name: { not: 'Acme Corp' } },
    data: { name: 'Acme Corp' },
  }])
})

test('an absent directory is a no-op', async () => {
  const prisma = {
    organization: {
      updateMany: async () => {
        throw new Error('must not be called')
      },
    },
  }
  await syncExternalOrganizationNames(prisma as never, undefined)
})
