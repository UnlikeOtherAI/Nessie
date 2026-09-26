import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerPeopleRoutes } from '../src/routes/people.js'
import { createUoaTeamMembershipDirectory } from '../src/services/uoa-team-memberships.js'
import {
  externalOrgId,
  json,
  organizationId,
  otherOrganizationId,
  rosterDeps as teamRosterDeps,
  teamId as workingTeamId,
  withUoaEnv,
  type StubCall,
} from './uoa-team-members-fixture.js'

/**
 * `GET /api/people` on an organisation bound to the sign-in provider: the
 * provider's roster, relayed per request with the caller's own assertion,
 * never stored.
 *
 * - The organisation's roster answers the provider's administration standing,
 *   and each person carries the teams the asker may see them in.
 * - A team's roster is any team of the organisation the address names — not
 *   only the one the session is working in — and the provider decides whether
 *   this person may read it.
 * - A named team that is not the organisation's own is a 404 before anything
 *   leaves for the provider, never a quiet fall-back to the working team.
 */

const SALES_ID = '00000000-0000-4000-8000-0000000000c2'
const LOCAL_ID = '00000000-0000-4000-8000-000000000004'
const SYSTEM_ID = '00000000-0000-4000-8000-0000000000c3'
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000c4'
const ADA_LOCAL_ID = '00000000-0000-4000-8000-0000000000a1'

type TeamRow = {
  externalOrgId: string | null
  externalTeamId: string | null
  id: string
  name: string
  organizationId: string
  systemManaged: boolean
}

const teams: TeamRow[] = [
  { externalOrgId, externalTeamId: 'team_design', id: workingTeamId, name: 'Design', organizationId, systemManaged: false },
  { externalOrgId, externalTeamId: 'team_sales', id: SALES_ID, name: 'Sales', organizationId, systemManaged: false },
  { externalOrgId: null, externalTeamId: null, id: LOCAL_ID, name: 'Local', organizationId, systemManaged: false },
  { externalOrgId: null, externalTeamId: null, id: SYSTEM_ID, name: 'Assistant', organizationId, systemManaged: true },
  { externalOrgId, externalTeamId: 'team_foreign', id: FOREIGN_ID, name: 'Elsewhere', organizationId: otherOrganizationId, systemManaged: false },
]

type TeamWhere = {
  OR?: Array<{ project?: { organizationId?: string } }>
  externalTeamId?: { not: null }
  id?: string
  systemManaged?: boolean
}

/** The organisation `organizationTeamsWhere` names, read back out of its shape. */
const organisationOf = (where: TeamWhere): string | undefined => where.OR?.[0]?.project?.organizationId

const teamMatches = (team: TeamRow, where: TeamWhere): boolean =>
  (where.id === undefined || team.id === where.id)
  && (where.systemManaged === undefined || team.systemManaged === where.systemManaged)
  && team.organizationId === organisationOf(where)
  && (where.externalTeamId === undefined || team.externalTeamId !== null)

const pick = (team: TeamRow) => ({
  externalOrgId: team.externalOrgId,
  externalTeamId: team.externalTeamId,
  id: team.id,
  name: team.name,
})

// Reads only: a delegate this route has no business calling is absent, so a
// write would fail the test as a TypeError rather than pass unnoticed.
const makePrisma = (): PrismaClient => ({
  organization: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === organizationId ? { externalOrgId } : null,
  },
  team: {
    findFirst: async ({ where }: { where: TeamWhere }) => {
      const team = teams.find((candidate) => teamMatches(candidate, where))
      return team ? pick(team) : null
    },
    findMany: async ({ where }: { where: TeamWhere }) =>
      teams.filter((candidate) => teamMatches(candidate, where)).map(pick),
  },
  user: {
    findMany: async () => [{ id: ADA_LOCAL_ID, uoaSub: 'usr_ada' }],
  },
}) as unknown as PrismaClient

const actorContextFor = (overrides: { uoaIdentity?: boolean } = {}): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: '00000000-0000-4000-8000-00000000000a', roles: ['member'] },
  actionContext: {
    requestId: 'req-people',
    ...(overrides.uoaIdentity === false
      ? {}
      : { uoaIdentity: { organizationId: externalOrgId, subject: 'usr_ada', teamId: 'team_design', tokenVersion: 7 } }),
  },
  tenant: { organizationId, projectId: null, teamId: workingTeamId },
} as unknown as AuthorizedActionContext)

const orgMembers = {
  data: [
    { identity: { displayName: 'Ada Lovelace', email: 'ada@acme.test' }, role: 'owner', status: 'ACTIVE', subject: 'usr_ada' },
    { identity: { displayName: 'Grace Hopper', email: 'grace@acme.test' }, role: 'member', status: 'ACTIVE', subject: 'usr_grace' },
  ],
  meta: { hasMore: false, nextCursor: null, prevCursor: null },
  permissions: { addMember: true, changeMemberRole: true, removeMember: true, viewMemberEmail: true },
  total: 2,
}

const teamRoster = (rows: Array<{ subject: string; teamRole: string }>) => ({
  data: rows.map((row) => ({ ...row, identity: { displayName: row.subject }, status: 'ACTIVE' })),
  meta: { hasMore: false, nextCursor: null, prevCursor: null },
  permissions: { addMember: true, changeMemberRole: true, removeMember: true, viewMemberEmail: true },
  total: rows.length,
})

type Options = { orgRole?: string; salesStatus?: number }

/** The provider, as far as these tests need it: `/org/me`, the organisation roster, two team rosters. */
const provider = (calls: StubCall[], options: Options = {}) => teamRosterDeps(calls, (call) => {
  const path = new URL(call.url).pathname
  if (path === '/org/me') {
    return json({ ok: true, org: { org_id: externalOrgId, org_role: options.orgRole ?? 'admin' } })
  }
  if (path === `/org/organisations/${externalOrgId}/members`) return json(orgMembers)
  if (path.endsWith('/teams/team_design/members')) {
    return json(teamRoster([{ subject: 'usr_ada', teamRole: 'admin' }, { subject: 'usr_grace', teamRole: 'member' }]))
  }
  if (path.endsWith('/teams/team_sales/members')) {
    return options.salesStatus
      ? json({ error: 'FORBIDDEN' }, options.salesStatus)
      : json(teamRoster([{ subject: 'usr_grace', teamRole: 'admin' }]))
  }
  return json({ error: 'NOT_FOUND' }, 404)
})

const makeApp = (actorContext: AuthorizedActionContext, calls: StubCall[], options: Options = {}) => {
  const deps = provider(calls, options)
  const app = Fastify({ logger: false })
  registerPeopleRoutes(
    app,
    {
      prisma: makePrisma(),
      requireActorContext: () => actorContext,
    } as unknown as Parameters<typeof registerPeopleRoutes>[1],
    deps,
    createUoaTeamMembershipDirectory({ rosterDeps: deps }),
  )
  return app
}

const paths = (calls: StubCall[]) => calls.map((call) => new URL(call.url).pathname)

type Body = {
  data: { items: Array<Record<string, unknown>>; permissions: Record<string, unknown>; source: string; team?: unknown }
  error?: { code: string }
  meta: { total?: number }
}

test('the organisation’s roster carries each person’s teams, for an organisation administrator', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor(), calls)
    const res = await app.inject({ method: 'GET', url: '/api/people' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as Body
    assert.equal(body.data.source, 'provider')
    assert.equal(body.meta.total, 2)
    assert.equal(body.data.permissions.addMember, true)
    const [ada, grace] = body.data.items
    assert.equal(ada?.userId, ADA_LOCAL_ID)
    assert.deepEqual(ada?.teams, [{ id: workingTeamId, name: 'Design', role: 'admin' }])
    assert.deepEqual(grace?.teams, [
      { id: workingTeamId, name: 'Design', role: 'member' },
      { id: SALES_ID, name: 'Sales', role: 'admin' },
    ])
    // Only the organisation's bound teams were asked, each with the caller's
    // own assertion — never a backend-mode read.
    assert.ok(paths(calls).some((path) => path.endsWith('/teams/team_design/members')))
    assert.ok(paths(calls).some((path) => path.endsWith('/teams/team_sales/members')))
    assert.equal(paths(calls).some((path) => path.endsWith('/teams/team_foreign/members')), false)
    assert.ok(calls.filter((call) => new URL(call.url).pathname !== '/org/me').every((call) => call.subjectAssertion))
    await app.close()
  })
})

test('a team the caller may not read leaves its column empty rather than failing the roster', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor(), calls, { salesStatus: 403 })
    const res = await app.inject({ method: 'GET', url: '/api/people' })
    assert.equal(res.statusCode, 200)
    const grace = (res.json() as Body).data.items[1]
    assert.deepEqual(grace?.teams, [{ id: workingTeamId, name: 'Design', role: 'member' }])
    await app.close()
  })
})

test('the organisation’s roster refuses somebody without the administration standing', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor(), calls, { orgRole: 'member' })
    const res = await app.inject({ method: 'GET', url: '/api/people' })
    assert.equal(res.statusCode, 403)
    assert.equal((res.json() as Body).error?.code, 'ORGANIZATION_ADMIN_REQUIRED')
    assert.deepEqual(paths(calls), ['/org/me'])
    await app.close()
  })
})

test('a team the session is not working in is read as that team, and named', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor(), calls)
    const res = await app.inject({ method: 'GET', url: `/api/people?team=${SALES_ID}&status=DEACTIVATED` })
    assert.equal(res.statusCode, 200)
    const body = res.json() as Body
    assert.deepEqual(body.data.team, { id: SALES_ID, name: 'Sales' })
    assert.equal(body.data.items[0]?.teamRole, 'admin')
    const [read] = calls
    assert.equal(new URL(read?.url ?? 'x:').pathname, `/org/organisations/${externalOrgId}/teams/team_sales/members`)
    assert.equal(new URL(read?.url ?? 'x:').searchParams.get('status'), 'DEACTIVATED')
    // The provider decides who may read a team; no organisation check stands in front.
    assert.equal(paths(calls).includes('/org/me'), false)
    await app.close()
  })
})

test('a team the provider will not show this person is its refusal, in words', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor(), calls, { salesStatus: 403 })
    const res = await app.inject({ method: 'GET', url: `/api/people?team=${SALES_ID}` })
    assert.equal(res.statusCode, 403)
    assert.equal((res.json() as Body).error?.code, 'TEAM_MEMBERS_REJECTED')
    await app.close()
  })
})

test('a named team that is not the organisation’s own is a 404 before anything leaves', async () => {
  await withUoaEnv(async () => {
    for (const team of ['00000000-0000-4000-8000-0000000000ff', SYSTEM_ID, FOREIGN_ID]) {
      const calls: StubCall[] = []
      const app = makeApp(actorContextFor(), calls)
      const res = await app.inject({ method: 'GET', url: `/api/people?team=${team}` })
      assert.equal(res.statusCode, 404, team)
      assert.equal((res.json() as Body).error?.code, 'TEAM_NOT_FOUND')
      assert.deepEqual(calls, [])
      await app.close()
    }
  })
})

test('a team the provider has never heard of has no relayed roster', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor(), calls)
    const res = await app.inject({ method: 'GET', url: `/api/people?team=${LOCAL_ID}` })
    assert.equal(res.statusCode, 404)
    assert.equal((res.json() as Body).error?.code, 'TEAM_NOT_LINKED')
    assert.deepEqual(calls, [])
    await app.close()
  })
})

test('an address that is not a team id is the caller’s error', async () => {
  await withUoaEnv(async () => {
    const app = makeApp(actorContextFor(), [])
    const res = await app.inject({ method: 'GET', url: '/api/people?team=design' })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})

test('without a current provider session nothing is relayed', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(actorContextFor({ uoaIdentity: false }), calls)
    const res = await app.inject({ method: 'GET', url: `/api/people?team=${SALES_ID}` })
    assert.equal(res.statusCode, 403)
    assert.equal((res.json() as Body).error?.code, 'UOA_SESSION_REQUIRED')
    assert.deepEqual(calls, [])
    await app.close()
  })
})
