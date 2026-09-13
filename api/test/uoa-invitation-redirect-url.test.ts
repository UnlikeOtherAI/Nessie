import assert from 'node:assert/strict'
import test from 'node:test'

import * as organizationScope from './uoa-organization-members-fixture.js'
import * as teamScope from './uoa-team-members-fixture.js'

/**
 * Every invitation mail must be able to bring the invitee back into Nessie.
 *
 * UOA hosts the acceptance page and ends it on "You can close this window"
 * unless the invitation carried a `redirectUrl`; Nessie sent none, at either
 * scope, on either create or resend, so a person who accepted an invitation had
 * to already know the product's address (2026-09-13 invitation e2e run, F5).
 *
 * The value asserted here is `UOA_REDIRECT_URL` — the same address the login
 * flow registers in the config JWT's `redirect_urls`, which is what UOA
 * validates the field against byte-exactly. A second, differently-configured
 * URL would be refused upstream, so the test pins the shared one rather than a
 * literal.
 */

const redirectUrl = teamScope.uoaEnv.UOA_REDIRECT_URL

const bodyOf = (call: { body?: string } | undefined): Record<string, unknown> => {
  assert.ok(call?.body, 'the relayed call carried a body')
  return JSON.parse(call.body) as Record<string, unknown>
}

test('a team-scope invitation carries the registered return address on create and resend', async () => {
  await teamScope.withUoaEnv(async () => {
    const calls: teamScope.StubCall[] = []
    const app = await teamScope.makeApp(
      teamScope.actorContextFor(['viewer']),
      teamScope.rosterDeps(calls, () => teamScope.json({ ok: true })),
    )
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/team/invitations',
        payload: { email: 'invitee@acme.test', teamRole: 'member' },
      })
      assert.equal(created.statusCode, 200)
      assert.deepEqual(bodyOf(calls.at(-1)), {
        email: 'invitee@acme.test',
        redirectUrl,
        teamRole: 'member',
      })

      const resent = await app.inject({
        method: 'POST',
        url: '/api/team/invitations/invite-1/resend',
      })
      assert.equal(resent.statusCode, 200)
      assert.equal(
        calls.at(-1)?.url,
        `https://uoa.test/org/organisations/${teamScope.externalOrgId}`
        + `/teams/${teamScope.externalTeamId}/invitations/invite-1/resend`
        + `?domain=nessie.test&config_url=${encodeURIComponent(teamScope.uoaEnv.UOA_CONFIG_URL)}`,
      )
      assert.deepEqual(bodyOf(calls.at(-1)), { redirectUrl })
    } finally {
      await app.close()
    }
  })
})

test('an organisation-scope invitation carries the same return address, and the workspace still travels', async () => {
  await organizationScope.withUoaEnv(async () => {
    const calls: organizationScope.StubCall[] = []
    const app = await organizationScope.makeApp(
      organizationScope.actorContextFor(['viewer']),
      organizationScope.rosterDeps(calls, () => organizationScope.json({ ok: true })),
    )
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/organization/member-invitations',
        payload: { email: 'invitee@acme.test', name: 'Invitee', teamId: 'team_product' },
      })
      assert.equal(created.statusCode, 200)
      // `teamId` addresses the workspace in the path and must not leak into the
      // invitation body; `redirectUrl` is added there and nowhere else.
      assert.deepEqual(bodyOf(calls.at(-1)), {
        email: 'invitee@acme.test',
        name: 'Invitee',
        redirectUrl,
      })
      assert.equal(
        calls.at(-1)?.url,
        `${organizationScope.base}/teams/team_product/invitations${organizationScope.query}`,
      )

      const resent = await app.inject({
        method: 'POST',
        url: '/api/organization/member-invitations/invite-1/resend',
        payload: { teamId: 'team_product' },
      })
      assert.equal(resent.statusCode, 200)
      assert.deepEqual(bodyOf(calls.at(-1)), { redirectUrl })
    } finally {
      await app.close()
    }
  })
})
