import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actorContextFor, base, json, makeApp, query, rosterDeps, withUoaEnv, type StubCall,
} from './uoa-organization-members-fixture.js'

test('an organisation invitation is sent once to each selected workspace', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(actorContextFor(['viewer']), rosterDeps(calls, () => json({ ok: true })))
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/organization/member-invitations',
        payload: { email: 'new@example.test', teamIds: ['team_product', 'team_design', 'team_product'] },
      })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().data, {
        ok: true, invitedTeamIds: ['team_product', 'team_design'], failedTeamIds: [],
      })
      const invites = calls.filter((call) => call.method === 'POST')
      assert.deepEqual(invites.map((call) => call.url), [
        `${base}/teams/team_product/invitations${query}`,
        `${base}/teams/team_design/invitations${query}`,
      ])
      assert.ok(invites.every((call) => call.subjectAssertion))
      assert.equal(JSON.parse(invites[0]?.body ?? '{}').email, 'new@example.test')

      const legacy = await app.inject({
        method: 'POST', url: '/api/organization/member-invitations',
        payload: { email: 'old@example.test', teamId: 'team_product' },
      })
      assert.equal(legacy.statusCode, 200, 'a previous-build admin bundle still sends one teamId')
      assert.equal(calls.at(-1)?.url, `${base}/teams/team_product/invitations${query}`)

      const before = calls.length
      const empty = await app.inject({
        method: 'POST', url: '/api/organization/member-invitations',
        payload: { email: 'new@example.test', teamIds: [] },
      })
      assert.equal(empty.statusCode, 400)
      assert.equal(calls.length, before, 'no workspace means no upstream invitation')
    } finally {
      await app.close()
    }
  })
})

test('a partly refused organisation invitation names the refused workspaces', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const refuse = (call: StubCall) => call.url.includes('/teams/team_design/')
    const app = await makeApp(actorContextFor(['viewer']), rosterDeps(calls, (call) =>
      refuse(call) ? json({ error: 'forbidden' }, 403) : json({ ok: true })))
    try {
      const partial = await app.inject({
        method: 'POST', url: '/api/organization/member-invitations',
        payload: { email: 'new@example.test', teamIds: ['team_product', 'team_design'] },
      })
      assert.equal(partial.statusCode, 200)
      assert.deepEqual(partial.json().data, {
        ok: true, invitedTeamIds: ['team_product'], failedTeamIds: ['team_design'],
      })

      const refused = await app.inject({
        method: 'POST', url: '/api/organization/member-invitations',
        payload: { email: 'new@example.test', teamIds: ['team_design'] },
      })
      assert.notEqual(refused.statusCode, 200, 'nothing sent is a refusal, not a success')
    } finally {
      await app.close()
    }
  })
})

test('organisation invitation actions use the row target team and a signed subject', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(actorContextFor(['viewer']), rosterDeps(calls, () => json({ ok: true })))
    try {
      for (const [action, method, suffix] of [
        ['revoke', 'DELETE', ''], ['resend', 'POST', '/resend'],
      ] as const) {
        const response = await app.inject({
          method: 'POST', url: `/api/organization/member-invitations/invite-1/${action}`,
          payload: { teamId: 'team_product' },
        })
        assert.equal(response.statusCode, 200)
        const call = calls.at(-1)
        assert.equal(call?.method, method)
        assert.equal(call?.url, `${base}/teams/team_product/invitations/invite-1${suffix}${query}`)
        assert.ok(call?.subjectAssertion)
      }
      const invalid = await app.inject({
        method: 'POST', url: '/api/organization/member-invitations/invite-1/resend', payload: {},
      })
      assert.equal(invalid.statusCode, 400)
      assert.equal(calls.length, 4, 'a missing target cannot silently use the session team')
    } finally {
      await app.close()
    }
  })
})
