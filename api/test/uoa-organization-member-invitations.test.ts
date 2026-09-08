import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actorContextFor, base, json, makeApp, query, rosterDeps, withUoaEnv, type StubCall,
} from './uoa-organization-members-fixture.js'

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
