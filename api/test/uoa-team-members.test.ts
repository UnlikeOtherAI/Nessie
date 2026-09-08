import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { buildConfigJwt, loadUoaSettings } from '../src/services/uoa-auth.js'
import { resolveUoaRosterTeam } from '../src/services/uoa-org-roster.js'
import {
  actorContextFor, externalOrgId, externalTeamId, forbidUpstream, json, localTeamId,
  makeApp, makePrisma, organizationId, otherOrganizationId, rosterDeps, teamId,
  teamRoster, uoaEnv, withUoaEnv, type StubCall,
} from './uoa-team-members-fixture.js'

test('the config JWT opts this domain into UOA backend org management', async () => {
  await withUoaEnv(async () => {
    const privateKeyPem = String(
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }),
    )
    const claims = JSON.parse(
      Buffer.from(
        buildConfigJwt({ ...loadUoaSettings(), privateKeyPem }).split('.')[1] ?? '',
        'base64url',
      ).toString('utf8'),
    ) as { org_features?: Record<string, unknown> }

    // Without this flag UOA answers 401 MISSING_ACCESS_TOKEN to every
    // backend-mode call, and Nessie holds no spendable user access token.
    assert.equal(claims.org_features?.backend_org_management, true)
  })
})
test('resolveUoaRosterTeam maps the session team to its UOA org + team', async () => {
  await withUoaEnv(async () => {
    const prisma = makePrisma()

    assert.deepEqual(
      await resolveUoaRosterTeam(prisma, { organizationId, teamId }),
      { externalOrgId, externalTeamId },
    )
    // No UOA mapping, no team in context, and another organisation's team all
    // resolve to nothing — there is never a fall back to local rows.
    assert.equal(
      await resolveUoaRosterTeam(prisma, { organizationId, teamId: localTeamId }),
      null,
    )
    assert.equal(await resolveUoaRosterTeam(prisma, { organizationId, teamId: null }), null)
    assert.equal(
      await resolveUoaRosterTeam(prisma, { organizationId: otherOrganizationId, teamId }),
      null,
    )
  })
})
// The mutation matrix lives in uoa-team-members-mutations.test.ts.
test('GET /api/team/members relays one paged UOA team roster', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['member']),
      rosterDeps(calls, () => json(teamRoster)),
    )

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/team/members?status=all&limit=25',
      })

      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data.items, [
        {
          uoaSub: 'usr_ada',
          displayName: 'Ada Lovelace',
          email: 'ada@acme.test',
          status: 'ACTIVE',
          teamRole: 'owner',
        },
        {
          uoaSub: 'usr_grace',
          displayName: 'Grace Hopper',
          email: 'grace@acme.test',
          status: 'DEACTIVATED',
          teamRole: 'member',
        },
      ])
      assert.deepEqual(response.json().meta, {
        hasMore: false,
        nextCursor: null,
        prevCursor: null,
        total: 2,
      })

      assert.equal(calls.length, 1)
      assert.equal(
        calls[0]?.url,
        `https://uoa.test/org/organisations/${externalOrgId}/teams/${externalTeamId}/members`
        + `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}&status=all&limit=25`,
      )
      for (const call of calls) {
        assert.match(call.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
        assert.equal(call.hasAccessToken, false, 'UOA access tokens are never persisted or forwarded')
        assert.ok(call.subjectAssertion, 'the current UOA subject must be asserted upstream')
        const claims = JSON.parse(
          Buffer.from(call.subjectAssertion!.split('.')[1]!, 'base64url').toString('utf8'),
        ) as Record<string, unknown>
        assert.deepEqual(
          {
            active: claims.active,
            aud: claims.aud,
            source_domain: claims.source_domain,
            sub: claims.sub,
            tv: claims.tv,
          },
          {
            active: { orgId: externalOrgId, teamId: externalTeamId },
            aud: 'https://uoa.test/org',
            source_domain: 'nessie.test',
            sub: 'usr_ada',
            tv: 7,
          },
        )
      }
    } finally {
      await app.close()
    }
  })
})
test('the roster tolerates an unusable upstream shape without inventing members', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => json({ members: 'everyone', data: { nope: true } })),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data.items, [])
    } finally {
      await app.close()
    }
  })
})

test('a body that is not JSON is an outage, not an empty roster', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => new Response('<html>gateway</html>', { status: 200 })),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')
    } finally {
      await app.close()
    }
  })
})

test('an upstream 5xx is reported as a directory outage', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, () => new Response('boom', { status: 503 })),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 502)
      assert.equal(response.json().error.code, 'UOA_DIRECTORY_UNAVAILABLE')
    } finally {
      await app.close()
    }
  })
})

test('an upstream refusal surfaces as a client error, not an outage', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['owner']),
      rosterDeps(calls, (call) =>
        json({ error: 'refused' }, call.method === 'DELETE' ? 404 : 409)),
    )

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/team/members/usr_ghost',
      })
      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error.code, 'TEAM_MEMBERS_REJECTED')

      const rejected = await app.inject({
        method: 'PUT',
        url: '/api/team/members/usr_ada/role',
        payload: { role: 'admin' },
      })
      assert.equal(rejected.statusCode, 409)
      assert.equal(rejected.json().error.code, 'TEAM_MEMBERS_REJECTED')
    } finally {
      await app.close()
    }
  })
})

test('a team with no UOA team 404s and never reaches UOA', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(
      actorContextFor(['owner'], { teamId: localTeamId }),
      forbidUpstream('an unlinked team must not reach the UOA org API'),
    )

    try {
      for (const request of [
        { method: 'GET' as const, url: '/api/team/members' },
        { method: 'GET' as const, url: '/api/team/invitations' },
        { method: 'DELETE' as const, url: '/api/team/members/usr_ada' },
        { method: 'POST' as const, url: '/api/team/invitations/inv_1/revoke' },
      ]) {
        const response = await app.inject(request)
        assert.equal(response.statusCode, 404, request.url)
        assert.equal(response.json().error.code, 'TEAM_NOT_LINKED')
      }
    } finally {
      await app.close()
    }
  })
})

test('the roster read is open to any member of the team', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['viewer']),
      rosterDeps(calls, () => json(teamRoster)),
    )

    try {
      const response = await app.inject({ method: 'GET', url: '/api/team/members' })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().data.items.length, 2)
    } finally {
      await app.close()
    }
  })
})
// Mutation coverage is intentionally isolated in uoa-team-members-mutations.test.ts.

