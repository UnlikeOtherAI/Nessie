import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { registerTeamMembersRoutes } from '../src/routes/team-members.js'
import {
  actorContextFor,
  externalOrgId,
  json,
  organizationId,
  otherOrganizationId,
  rosterDeps,
  teamId as workingTeamId,
  teamRoster,
  withUoaEnv,
  type StubCall,
} from './uoa-team-members-fixture.js'

/**
 * `?team=<id>` on the team member routes: Admin › People shows any team the
 * viewer may read, so a read or a write from it reaches the team the address
 * names, not the one the session is working in. The provider still authorises
 * the exact target; a team that is not the organisation's own is a 404 before
 * anything leaves; and the audit entry names the team the change was made to.
 */

const SALES_ID = '00000000-0000-4000-8000-0000000000c2'
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000c4'

type TeamRow = { externalOrgId: string; externalTeamId: string; id: string; organizationId: string }

const teams: TeamRow[] = [
  { externalOrgId, externalTeamId: 'team_design', id: workingTeamId, organizationId },
  { externalOrgId, externalTeamId: 'team_sales', id: SALES_ID, organizationId },
  { externalOrgId, externalTeamId: 'team_foreign', id: FOREIGN_ID, organizationId: otherOrganizationId },
]

type TeamWhere = {
  OR?: Array<{ project?: { organizationId?: string } }>
  id: string
  project?: { organizationId: string }
}

const makePrisma = (audits: Array<Record<string, unknown>>): PrismaClient => {
  const tx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data)
        return data
      },
      findFirst: async () => null,
    },
  }
  return {
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    team: {
      // Both shapes the route asks: `organizationTeamsWhere` for a named team,
      // and the anchor-project shape `resolveUoaRosterTeam` reads the binding by.
      findFirst: async ({ where }: { where: TeamWhere }) => {
        const organisation = where.project?.organizationId ?? where.OR?.[0]?.project?.organizationId
        const team = teams.find((candidate) => candidate.id === where.id && candidate.organizationId === organisation)
        return team ? { externalOrgId: team.externalOrgId, externalTeamId: team.externalTeamId, id: team.id } : null
      },
    },
    user: { findMany: async () => [] },
  } as unknown as PrismaClient
}

const makeApp = (calls: StubCall[], audits: Array<Record<string, unknown>>) => {
  const app = Fastify({ logger: false })
  registerTeamMembersRoutes(
    app,
    {
      prisma: makePrisma(audits),
      requireActorContext: () => actorContextFor(['member']),
    } as unknown as Parameters<typeof registerTeamMembersRoutes>[1],
    rosterDeps(calls, () => json({ ...teamRoster, ok: true })),
  )
  return app
}

const pathOf = (call: StubCall | undefined) => new URL(call?.url ?? 'x:').pathname

test('a roster read reaches the team the address names', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(calls, [])
    const res = await app.inject({ method: 'GET', url: `/api/team/members?team=${SALES_ID}` })
    assert.equal(res.statusCode, 200)
    assert.equal(pathOf(calls[0]), `/org/organisations/${externalOrgId}/teams/team_sales/members`)
    await app.close()
  })
})

test('with no team named, the working team is meant, as before', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(calls, [])
    await app.inject({ method: 'GET', url: '/api/team/invitations' })
    assert.equal(pathOf(calls[0]), `/org/organisations/${externalOrgId}/teams/team_design/member-invitations`)
    await app.close()
  })
})

test('a write reaches the named team, and its audit entry names it', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const audits: Array<Record<string, unknown>> = []
    const app = makeApp(calls, audits)
    const res = await app.inject({
      method: 'PUT',
      payload: { role: 'admin' },
      url: `/api/team/members/usr_grace/role?team=${SALES_ID}`,
    })
    assert.equal(res.statusCode, 200)
    assert.equal(calls[0]?.method, 'PUT')
    assert.equal(pathOf(calls[0]), `/org/organisations/${externalOrgId}/teams/team_sales/members/usr_grace`)
    // The provider authorises the exact team from the caller's own assertion.
    assert.ok(calls[0]?.subjectAssertion)
    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.action, 'user.role_changed')
    assert.deepEqual(audits[0]?.metadata, { targetTeamId: SALES_ID })
    await app.close()
  })
})

test('a team that is not the organisation’s own is a 404 before anything leaves', async () => {
  await withUoaEnv(async () => {
    for (const team of [FOREIGN_ID, '00000000-0000-4000-8000-0000000000ff']) {
      const calls: StubCall[] = []
      const audits: Array<Record<string, unknown>> = []
      const app = makeApp(calls, audits)
      const res = await app.inject({ method: 'DELETE', url: `/api/team/members/usr_grace?team=${team}` })
      assert.equal(res.statusCode, 404, team)
      assert.equal((res.json() as { error: { code: string } }).error.code, 'TEAM_NOT_FOUND')
      assert.deepEqual(calls, [])
      assert.deepEqual(audits, [])
      await app.close()
    }
  })
})

test('a team named in a form other than an id is the caller’s error', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = makeApp(calls, [])
    const res = await app.inject({ method: 'POST', url: '/api/team/invitations/invite-1/resend?team=sales', payload: {} })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(calls, [])
    await app.close()
  })
})
