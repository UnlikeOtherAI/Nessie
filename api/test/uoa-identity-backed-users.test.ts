import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listUoaUsersForOrganization,
  UoaIdentityMappingError,
} from '../src/services/users.js'

const now = new Date('2026-09-10T12:00:00.000Z')

const localUser = (overrides: Record<string, unknown> = {}) => ({
  channelMembers: [{ channelId: '11111111-1111-4111-8111-111111111111' }],
  createdAt: now,
  id: '22222222-2222-4222-8222-222222222222',
  statuses: [],
  uoaSub: 'uoa-subject-1',
  updatedAt: now,
  ...overrides,
})

test('UOA-backed user selectors read profile and role only from the live directory', async () => {
  let query: Record<string, unknown> | undefined
  const prisma = {
    user: {
      findMany: async (input: Record<string, unknown>) => {
        query = input
        return [localUser({
          avatarUrl: 'https://stale.example/avatar.png',
          displayName: 'Stale local name',
          email: 'stale@example.test',
          organizationMembers: [{ deactivatedAt: now, role: 'owner' }],
        })]
      },
    },
  }

  const result = await listUoaUsersForOrganization(prisma as never, 'org-1', [{
    avatarImageUrl: 'https://uoa.example/avatar.png',
    displayName: 'Live UOA name',
    email: 'live@example.test',
    orgRole: 'member',
    status: 'ACTIVE',
    uoaSub: 'uoa-subject-1',
  }])

  assert.equal(result.length, 1)
  assert.deepEqual(result[0], {
    activeStatus: null,
    avatarUrl: 'https://uoa.example/avatar.png',
    channelIds: ['11111111-1111-4111-8111-111111111111'],
    createdAt: now.toISOString(),
    displayName: 'Live UOA name',
    email: 'live@example.test',
    id: '22222222-2222-4222-8222-222222222222',
    role: 'member',
    updatedAt: now.toISOString(),
  })
  const select = query?.select as Record<string, unknown>
  assert.equal(select.email, undefined)
  assert.equal(select.displayName, undefined)
  assert.equal(select.avatarUrl, undefined)
  assert.equal(select.organizationMembers, undefined)
})

test('a local principal revoked upstream is absent from UOA-backed selectors', async () => {
  const prisma = { user: { findMany: async () => [localUser()] } }
  const result = await listUoaUsersForOrganization(prisma as never, 'org-1', [])
  assert.deepEqual(result, [])
})

test('a bound organization with a subjectless legacy principal fails explicitly', async () => {
  const prisma = {
    user: { findMany: async () => [localUser({ uoaSub: null })] },
  }

  await assert.rejects(
    listUoaUsersForOrganization(prisma as never, 'org-1', []),
    UoaIdentityMappingError,
  )
})

test('an incomplete upstream identity never falls back to copied local profile fields', async () => {
  const prisma = { user: { findMany: async () => [localUser()] } }

  await assert.rejects(
    listUoaUsersForOrganization(prisma as never, 'org-1', [{
      displayName: 'No email or role',
      uoaSub: 'uoa-subject-1',
    }]),
    UoaIdentityMappingError,
  )
})
