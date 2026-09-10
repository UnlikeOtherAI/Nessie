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

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

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

test('concurrent misses for one actor share one load and one cache count', async () => {
  let calls = 0
  const pending = deferred<ReturnType<typeof page>>()
  const directory = createUoaIdentityDirectory({
    loadPage: async () => {
      calls += 1
      return pending.promise
    },
    maxCachedMembers: 1,
    now: () => 0,
  })
  const input = { externalOrgId: 'uoa-org-1', identity }

  const first = directory.list(input)
  const second = directory.list(input)
  await Promise.resolve()
  assert.equal(calls, 1)
  pending.resolve(page([{
    uoaSub: 'subject-1',
    displayName: 'Person',
    email: 'person@example.test',
    orgRole: 'member',
  }]))

  const [firstResult, secondResult] = await Promise.all([first, second])
  const thirdResult = await directory.list(input)
  assert.deepEqual(secondResult, firstResult)
  assert.deepEqual(thirdResult, firstResult)
  assert.equal(calls, 1)
})

test('invalidation supersedes an obsolete coalesced load before it can refill', async () => {
  let calls = 0
  const pending = [deferred<ReturnType<typeof page>>(), deferred<ReturnType<typeof page>>()]
  const directory = createUoaIdentityDirectory({
    loadPage: async () => {
      const request = pending[calls]
      calls += 1
      assert.ok(request)
      return request.promise
    },
    now: () => 0,
  })
  const input = { externalOrgId: 'uoa-org-1', identity }

  const obsolete = directory.list(input)
  const obsoleteCoalesced = directory.list(input)
  await Promise.resolve()
  assert.equal(calls, 1)
  directory.invalidateOrganization('uoa-org-1')
  const fresh = directory.list(input)
  await Promise.resolve()
  assert.equal(calls, 2)

  pending[0]?.resolve(page([{
    uoaSub: 'removed-subject',
    displayName: 'Removed',
    email: 'removed@example.test',
    orgRole: 'member',
  }]))
  pending[1]?.resolve(page([]))

  assert.equal((await obsolete)[0]?.uoaSub, 'removed-subject')
  assert.equal((await obsoleteCoalesced)[0]?.uoaSub, 'removed-subject')
  assert.deepEqual(await fresh, [])
  assert.deepEqual(await directory.list(input), [])
  assert.equal(calls, 2)
})

test('the tracked in-flight set refuses an unbounded fan-out', async () => {
  const pending = deferred<ReturnType<typeof page>>()
  const directory = createUoaIdentityDirectory({
    loadPage: async () => pending.promise,
    maxInFlight: 1,
  })
  const first = directory.list({ externalOrgId: 'uoa-org-1', identity })
  await Promise.resolve()

  await assert.rejects(
    directory.list({
      externalOrgId: 'uoa-org-2',
      identity: { ...identity, organizationId: 'uoa-org-2' },
    }),
    /too many organization directory reads/,
  )
  pending.resolve(page([]))
  await first
})

test('an invalidated load retains capacity until it settles', async () => {
  let calls = 0
  const pending = [deferred<ReturnType<typeof page>>(), deferred<ReturnType<typeof page>>()]
  const directory = createUoaIdentityDirectory({
    loadPage: async () => {
      const request = pending[calls]
      calls += 1
      assert.ok(request)
      return request.promise
    },
    maxInFlight: 1,
  })
  const input = { externalOrgId: 'uoa-org-1', identity }

  const obsolete = directory.list(input)
  await Promise.resolve()
  directory.invalidateOrganization('uoa-org-1')
  await assert.rejects(
    directory.list(input),
    /too many organization directory reads/,
  )
  pending[0]?.resolve(page([{
    uoaSub: 'removed-subject',
    displayName: 'Removed',
    email: 'removed@example.test',
    orgRole: 'member',
  }]))
  await obsolete

  const fresh = directory.list(input)
  await Promise.resolve()
  pending[1]?.resolve(page([]))
  assert.deepEqual(await fresh, [])
  assert.equal(calls, 2)
})
