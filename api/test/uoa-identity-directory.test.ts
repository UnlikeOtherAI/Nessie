import assert from 'node:assert/strict'
import test from 'node:test'

import { UoaRosterUnavailableError } from '../src/services/uoa-org-roster.js'
import { createUoaIdentityDirectory } from '../src/services/uoa-identity-directory.js'

const identity = {
  organizationId: 'uoa-org-1',
  subject: 'uoa-user-1',
  teamId: 'uoa-team-1',
  tokenVersion: 4,
}

const page = (
  items: Array<{ uoaSub: string; displayName: string; email: string; orgRole: string }>,
  nextCursor: string | null = null,
) => ({
  items,
  meta: { hasMore: nextCursor !== null, nextCursor, prevCursor: null },
  permissions: {},
})

test('identity directory reads every page and caches only the complete result', async () => {
  let calls = 0
  const directory = createUoaIdentityDirectory({
    loadPage: async (_input, query) => {
      calls += 1
      assert.equal(query.limit, 100)
      assert.equal(query.status, 'ACTIVE')
      return query.cursor
        ? page([{ uoaSub: 'subject-2', displayName: 'B', email: 'b@example.test', orgRole: 'member' }])
        : page(
          [{ uoaSub: 'subject-1', displayName: 'A', email: 'a@example.test', orgRole: 'owner' }],
          'next-page',
        )
    },
  })

  const first = await directory.list({ externalOrgId: 'uoa-org-1', identity })
  const second = await directory.list({ externalOrgId: 'uoa-org-1', identity })

  assert.deepEqual(first.map((member) => member.uoaSub), ['subject-1', 'subject-2'])
  assert.deepEqual(second, first)
  assert.equal(calls, 2)
})

test('credential epoch, active team, expiry, and explicit invalidation revalidate the cache', async () => {
  let clock = 1_000
  let calls = 0
  const directory = createUoaIdentityDirectory({
    loadPage: async () => {
      calls += 1
      return page([{
        uoaSub: `subject-${calls}`,
        displayName: 'Person',
        email: 'person@example.test',
        orgRole: 'member',
      }])
    },
    now: () => clock,
    ttlMs: 50,
  })

  await directory.list({ externalOrgId: 'uoa-org-1', identity })
  await directory.list({ externalOrgId: 'uoa-org-1', identity: { ...identity, tokenVersion: 5 } })
  await directory.list({ externalOrgId: 'uoa-org-1', identity: { ...identity, teamId: 'uoa-team-2' } })
  clock += 51
  await directory.list({ externalOrgId: 'uoa-org-1', identity })
  directory.invalidateOrganization('uoa-org-1')
  await directory.list({ externalOrgId: 'uoa-org-1', identity })

  assert.equal(calls, 5)
})

test('expired data is never served when revalidation fails', async () => {
  let clock = 1_000
  let fail = false
  const directory = createUoaIdentityDirectory({
    loadPage: async () => {
      if (fail) throw new UoaRosterUnavailableError('offline')
      return page([{
        uoaSub: 'subject-1',
        displayName: 'Person',
        email: 'person@example.test',
        orgRole: 'member',
      }])
    },
    now: () => clock,
    ttlMs: 50,
  })

  await directory.list({ externalOrgId: 'uoa-org-1', identity })
  clock += 51
  fail = true

  await assert.rejects(
    directory.list({ externalOrgId: 'uoa-org-1', identity }),
    UoaRosterUnavailableError,
  )
})

test('an incomplete pagination cursor fails instead of truncating the directory', async () => {
  const directory = createUoaIdentityDirectory({
    loadPage: async () => ({
      ...page([], null),
      meta: { hasMore: true, nextCursor: null, prevCursor: null },
    }),
  })

  await assert.rejects(
    directory.list({ externalOrgId: 'uoa-org-1', identity }),
    /incomplete page cursor/,
  )
})

test('the cache evicts entries when its total member bound is exceeded', async () => {
  let calls = 0
  const directory = createUoaIdentityDirectory({
    loadPage: async () => {
      calls += 1
      return page([
        { uoaSub: 'subject-1', displayName: 'A', email: 'a@example.test', orgRole: 'member' },
        { uoaSub: 'subject-2', displayName: 'B', email: 'b@example.test', orgRole: 'member' },
      ])
    },
    maxCachedMembers: 1,
  })

  await directory.list({ externalOrgId: 'uoa-org-1', identity })
  await directory.list({ externalOrgId: 'uoa-org-1', identity })

  assert.equal(calls, 2)
})
