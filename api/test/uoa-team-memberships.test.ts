import assert from 'node:assert/strict'
import test from 'node:test'

import { UoaRosterRejectedError, UoaRosterUnavailableError } from '../src/services/uoa-org-roster.js'
import { createUoaTeamMembershipDirectory } from '../src/services/uoa-team-memberships.js'

/**
 * Which teams each person is in, on a bound organisation: read from the team
 * rosters with the asker's own assertion, held for seconds, never stored. A
 * team the asker may not read adds nothing; an outage is an error, never a
 * shorter answer; a roster write drops what was held.
 */

const identity = { organizationId: 'org_acme', subject: 'usr_ada', teamId: 'team_design', tokenVersion: 7 }
const DESIGN = { externalTeamId: 'team_design', id: '00000000-0000-4000-8000-0000000000d1', name: 'Design' }
const SALES = { externalTeamId: 'team_sales', id: '00000000-0000-4000-8000-0000000000d2', name: 'Sales' }

type Row = { status?: string; teamRole?: string; uoaSub: string }

const page = (items: Row[], nextCursor: string | null = null) => ({
  items,
  meta: { hasMore: nextCursor !== null, nextCursor, prevCursor: null },
  permissions: {},
})

const rosters: Record<string, Row[]> = {
  team_design: [
    { status: 'ACTIVE', teamRole: 'admin', uoaSub: 'usr_ada' },
    { status: 'ACTIVE', teamRole: 'member', uoaSub: 'usr_grace' },
    { status: 'REMOVED', teamRole: 'member', uoaSub: 'usr_gone' },
  ],
  team_sales: [{ status: 'DEACTIVATED', teamRole: 'member', uoaSub: 'usr_grace' }],
}

test('each person carries every team they are in, with their role there', async () => {
  const directory = createUoaTeamMembershipDirectory({
    loadPage: async (input, query) => {
      assert.equal(query.status, 'all')
      assert.equal(input.identity.subject, 'usr_ada')
      return page(rosters[input.externalTeamId] ?? [])
    },
  })

  const memberships = await directory.membershipsBySubject({
    externalOrgId: 'org_acme',
    identity,
    teams: [SALES, DESIGN],
  })
  assert.deepEqual(memberships.get('usr_ada'), [{ id: DESIGN.id, name: 'Design', role: 'admin' }])
  // Deactivated in the organisation still shows where they are: that is
  // where reactivating them is decided.
  assert.deepEqual(memberships.get('usr_grace'), [
    { id: DESIGN.id, name: 'Design', role: 'member' },
    { id: SALES.id, name: 'Sales', role: 'member' },
  ])
  assert.equal(memberships.has('usr_gone'), false)
})

test('a team the asker may not read adds nothing and fails nothing', async () => {
  const directory = createUoaTeamMembershipDirectory({
    loadPage: async (input) => {
      if (input.externalTeamId === 'team_sales') throw new UoaRosterRejectedError('[uoa] forbidden', 403)
      return page(rosters[input.externalTeamId] ?? [])
    },
  })

  const memberships = await directory.membershipsBySubject({ externalOrgId: 'org_acme', identity, teams: [DESIGN, SALES] })
  assert.deepEqual(memberships.get('usr_grace'), [{ id: DESIGN.id, name: 'Design', role: 'member' }])
})

test('an outage is an error, never a shorter list of teams', async () => {
  const directory = createUoaTeamMembershipDirectory({
    loadPage: async (input) => {
      if (input.externalTeamId === 'team_sales') throw new UoaRosterUnavailableError('[uoa] offline')
      return page(rosters[input.externalTeamId] ?? [])
    },
  })

  await assert.rejects(
    directory.membershipsBySubject({ externalOrgId: 'org_acme', identity, teams: [DESIGN, SALES] }),
    UoaRosterUnavailableError,
  )
})

test('every page of a team is read, and an incomplete cursor fails', async () => {
  const directory = createUoaTeamMembershipDirectory({
    loadPage: async (_input, query) => (query.cursor
      ? page([{ teamRole: 'member', uoaSub: 'usr_second_page' }])
      : page([{ teamRole: 'member', uoaSub: 'usr_first_page' }], 'next')),
  })
  const memberships = await directory.membershipsBySubject({ externalOrgId: 'org_acme', identity, teams: [DESIGN] })
  assert.ok(memberships.has('usr_first_page'))
  assert.ok(memberships.has('usr_second_page'))

  const broken = createUoaTeamMembershipDirectory({
    loadPage: async () => ({ ...page([]), meta: { hasMore: true, nextCursor: null, prevCursor: null } }),
  })
  await assert.rejects(
    broken.membershipsBySubject({ externalOrgId: 'org_acme', identity, teams: [DESIGN] }),
    /incomplete page cursor/,
  )
})

test('the answer is held for the asker, and a roster write or a new epoch reads again', async () => {
  let clock = 1_000
  let calls = 0
  const directory = createUoaTeamMembershipDirectory({
    loadPage: async (input) => {
      calls += 1
      return page(rosters[input.externalTeamId] ?? [])
    },
    now: () => clock,
    ttlMs: 50,
  })
  const input = { externalOrgId: 'org_acme', identity, teams: [DESIGN] }

  await directory.membershipsBySubject(input)
  await directory.membershipsBySubject(input)
  assert.equal(calls, 1)

  // Another asker, another epoch, another team list: each its own question.
  await directory.membershipsBySubject({ ...input, identity: { ...identity, subject: 'usr_grace' } })
  await directory.membershipsBySubject({ ...input, identity: { ...identity, tokenVersion: 8 } })
  await directory.membershipsBySubject({ ...input, teams: [DESIGN, SALES] })
  assert.equal(calls, 1 + 1 + 1 + 2)

  directory.invalidateOrganization('org_acme')
  await directory.membershipsBySubject(input)
  assert.equal(calls, 6)

  clock += 51
  await directory.membershipsBySubject(input)
  assert.equal(calls, 7)
})

test('a caller cannot change what the next caller is served', async () => {
  const directory = createUoaTeamMembershipDirectory({
    loadPage: async (input) => page(rosters[input.externalTeamId] ?? []),
  })
  const input = { externalOrgId: 'org_acme', identity, teams: [DESIGN] }
  const first = await directory.membershipsBySubject(input)
  first.get('usr_ada')?.push({ id: 'forged', name: 'Forged' })
  first.delete('usr_grace')

  const second = await directory.membershipsBySubject(input)
  assert.deepEqual(second.get('usr_ada'), [{ id: DESIGN.id, name: 'Design', role: 'admin' }])
  assert.ok(second.has('usr_grace'))
})
