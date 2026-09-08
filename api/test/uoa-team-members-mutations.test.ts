import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actorContextFor, externalOrgId, externalTeamId, forbidUpstream, json,
  makeApp, rosterDeps, uoaEnv, withUoaEnv, type StubCall,
} from './uoa-team-members-fixture.js'

test('UOA refuses unauthorized mutations regardless of the projected local role', async () => {
  for (const role of ['viewer', 'owner']) {
    await withUoaEnv(async () => {
      const calls: StubCall[] = []
      const app = await makeApp(
        actorContextFor([role]),
        rosterDeps(calls, () => json({ code: 'FORBIDDEN' }, 403)),
      )
      try {
        const response = await app.inject({
          method: 'POST', url: '/api/team/members', payload: { uoaSub: 'usr_grace' },
        })
        assert.equal(response.statusCode, 403)
        assert.equal(response.json().error.code, 'TEAM_MEMBERS_REJECTED')
        assert.match(response.json().error.message, /permission/)
        assert.equal(calls.length, 1)
        assert.ok(calls[0]?.subjectAssertion)
      } finally {
        await app.close()
      }
    })
  }
})

test('UOA-authorized users drive the member and invitation mutations', async () => {
  for (const role of ['owner', 'admin', 'viewer']) {
    await withUoaEnv(async () => {
      const calls: StubCall[] = []
      const app = await makeApp(
        actorContextFor([role]),
        rosterDeps(calls, (call) => {
          if (call.method === 'GET') {
            return json({
              data: [{ inviteId: 'inv_1', email: 'new@acme.test', status: 'pending' }],
              total: 1,
              meta: { hasMore: false, nextCursor: null, prevCursor: null },
              permissions: { createInvitation: true, viewPendingInvitations: true },
            })
          }
          // UOA's revoke answers the agreed `{ ok: true }`; the member DELETE
          // ignores its body, so one shape serves both.
          if (call.method === 'DELETE') return json({ ok: true })
          return json({ results: [{ email: 'new@acme.test', status: 'invited' }] })
        }),
      )

      const base = `https://uoa.test/org/organisations/${externalOrgId}`
      const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`
      const expected: {
        request: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }
        upstream: { method: string; url: string; body?: string }
      }[] = [
        {
          request: { method: 'GET', url: '/api/team/invitations' },
          upstream: { method: 'GET', url: `${base}/teams/${externalTeamId}/member-invitations${query}` },
        },
        {
          request: {
            method: 'POST',
            url: '/api/team/invitations',
            payload: { email: ' new@acme.test ', teamRole: 'member' },
          },
          upstream: {
            method: 'POST',
            url: `${base}/teams/${externalTeamId}/invitations${query}`,
            body: JSON.stringify({
              email: 'new@acme.test', teamRole: 'member',
            }),
          },
        },
        {
          request: {
            method: 'POST',
            url: '/api/team/members',
            payload: { uoaSub: 'usr_grace', teamRole: 'member' },
          },
          upstream: {
            method: 'POST',
            url: `${base}/teams/${externalTeamId}/members${query}`,
            body: JSON.stringify({ userId: 'usr_grace', teamRole: 'member' }),
          },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/resend' },
          upstream: {
            method: 'POST',
            url: `${base}/teams/${externalTeamId}/invitations/inv_1/resend${query}`,
          },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/revoke' },
          upstream: {
            method: 'DELETE',
            url: `${base}/teams/${externalTeamId}/invitations/inv_1${query}`,
          },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/approve' },
          upstream: { method: 'POST', url: `${base}/invitations/inv_1/approve${query}` },
        },
        {
          request: { method: 'POST', url: '/api/team/invitations/inv_1/deny' },
          upstream: { method: 'POST', url: `${base}/invitations/inv_1/deny${query}` },
        },
        {
          request: {
            method: 'PUT',
            url: '/api/team/members/usr_ada/role',
            payload: { role: 'admin' },
          },
          upstream: {
            method: 'PUT',
            url: `${base}/teams/${externalTeamId}/members/usr_ada${query}`,
            body: JSON.stringify({ teamRole: 'admin' }),
          },
        },
        {
          request: { method: 'DELETE', url: '/api/team/members/usr_ada' },
          upstream: {
            method: 'DELETE',
            url: `${base}/teams/${externalTeamId}/members/usr_ada${query}`,
          },
        },
        {
          request: { method: 'POST', url: '/api/team/members/usr_ada/deactivate' },
          upstream: { method: 'POST', url: `${base}/members/usr_ada/deactivate${query}` },
        },
        {
          request: { method: 'POST', url: '/api/team/members/usr_ada/reactivate' },
          upstream: { method: 'POST', url: `${base}/members/usr_ada/reactivate${query}` },
        },
      ]

      try {
        for (const [index, step] of expected.entries()) {
          const response = await app.inject(step.request)
          assert.equal(response.statusCode, 200, `${role} ${step.request.url}`)
          const call = calls[index]
          assert.equal(call?.method, step.upstream.method, step.request.url)
          assert.equal(call?.url, step.upstream.url, step.request.url)
          assert.equal(call?.hasAccessToken, false)
          if (step.upstream.body !== undefined) {
            assert.equal(call?.body, step.upstream.body, step.request.url)
          }
        }
        assert.deepEqual(calls.length, expected.length)
        // UOA owns exact-team, normalized-email invitation uniqueness. A
        // second submission must reach its signed-subject invite endpoint
        // unchanged, where UOA replaces the actionable invite and sends the
        // fresh email; Nessie must not keep a local duplicate detector.
        assert.deepEqual((await app.inject(expected[1].request)).json().data, { ok: true })
        const repeated = calls.at(-1)
        assert.equal(repeated?.method, expected[1]?.upstream.method)
        assert.equal(repeated?.url, expected[1]?.upstream.url)
        assert.equal(repeated?.body, expected[1]?.upstream.body)
        assert.equal(calls.length, expected.length + 1)
      } finally {
        await app.close()
      }
    })
  }
})

test('revoking an accepted invitation answers 409, not the generic refusal', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const app = await makeApp(
      actorContextFor(['admin']),
      rosterDeps(calls, () => json({ error: 'invitation_already_accepted' }, 409)),
    )

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/team/invitations/inv_taken/revoke',
      })
      // "Too late, they are a member now" is a different answer from "no such
      // invitation", and the person is told which one it is.
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().error.code, 'INVITATION_ALREADY_ACCEPTED')

      // Other conflicts retain their status without claiming acceptance.
      const generic = await app.inject({
        method: 'POST',
        url: '/api/team/invitations/inv_1/resend',
      })
      assert.equal(generic.statusCode, 409)
      assert.equal(generic.json().error.code, 'TEAM_MEMBERS_REJECTED')
    } finally {
      await app.close()
    }
  })
})

test('an invitation request with no usable email is refused before any relay', async () => {
  await withUoaEnv(async () => {
    const app = await makeApp(
      actorContextFor(['owner']),
      forbidUpstream('an invalid invitation must not reach UOA'),
    )

    try {
      for (const payload of [{ invites: [] }, { invites: [{ email: 'not-an-email' }] }, {}]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/team/invitations',
          payload,
        })
        assert.equal(response.statusCode, 400)
        assert.equal(response.json().error.code, 'VALIDATION_ERROR')
      }

      const badRole = await app.inject({
        method: 'PUT',
        url: '/api/team/members/usr_ada/role',
        payload: { role: 'owner' },
      })
      assert.equal(badRole.statusCode, 400)
    } finally {
      await app.close()
    }
  })
})

test('team member routes are inert when UOA is not configured', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  const app = await makeApp(
    actorContextFor(['owner']),
    forbidUpstream('an unconfigured deployment must not call UOA'),
  )

  try {
    const response = await app.inject({ method: 'GET', url: '/api/team/members' })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'TEAM_NOT_LINKED')
  } finally {
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
    await app.close()
  }
})

// UOA's ChangeTeamMemberRoleBodySchema / AddTeamMemberBodySchema use camelCase.
// Validate at the remote seam rather than returning success for any body.
test('role edits and existing-person adds satisfy UOA request schemas', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    let assignedRole = 'member'
    let addedSubject: string | undefined
    const app = await makeApp(actorContextFor(['viewer']), rosterDeps(calls, (call) => {
      const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>
      if (call.method === 'PUT') {
        if (typeof body.teamRole !== 'string') return json({ code: 'BAD_REQUEST' }, 400)
        assignedRole = body.teamRole
      } else {
        if (typeof body.userId !== 'string') return json({ code: 'BAD_REQUEST' }, 400)
        addedSubject = body.userId
      }
      return json({ ok: true })
    }))
    try {
      assert.equal((await app.inject({
        method: 'PUT', url: '/api/team/members/usr_grace/role', payload: { role: 'admin' },
      })).statusCode, 200)
      assert.equal(assignedRole, 'admin')
      assert.equal((await app.inject({
        method: 'POST', url: '/api/team/members', payload: { uoaSub: 'usr_grace' },
      })).statusCode, 200)
      assert.equal(addedSubject, 'usr_grace')
      assert.deepEqual(JSON.parse(calls[1]?.body ?? '{}'), { userId: 'usr_grace' })
    } finally {
      await app.close()
    }
  })
})

test('missing, old, and cross-organisation subjects never fall back to backend mode', async () => {
  await withUoaEnv(async () => {
    const current = actorContextFor(['owner']).actionContext.uoaIdentity!
    for (const identity of [undefined, { ...current, tokenVersion: null }, { ...current, organizationId: 'other' }]) {
      const actor = actorContextFor(['owner'])
      actor.actionContext.uoaIdentity = identity
      const app = await makeApp(actor, forbidUpstream('invalid subjects must fail before egress'))
      try {
        for (const request of [
          { method: 'PUT' as const, url: '/api/team/members/usr_grace/role', payload: { role: 'admin' } },
          { method: 'POST' as const, url: '/api/team/invitations', payload: { email: 'new@acme.test' } },
          { method: 'POST' as const, url: '/api/team/invitations/inv_1/resend' },
          { method: 'POST' as const, url: '/api/team/invitations/inv_1/revoke' },
          { method: 'DELETE' as const, url: '/api/team/members/usr_grace' },
        ]) {
          const response = await app.inject(request)
          assert.equal(response.statusCode, 403)
          assert.equal(response.json().error.code, 'UOA_SESSION_REQUIRED')
        }
      } finally {
        await app.close()
      }
    }
  })
})

test('upstream failures identify the remedy without exposing provider response content', async () => {
  await withUoaEnv(async () => {
    for (const [status, expectedStatus, message] of [
      [401, 403, /Sign in again/], [403, 403, /permission/], [404, 404, /no longer available/],
      [409, 409, /conflicts/], [429, 429, /Wait a moment/], [500, 502, /temporarily unavailable/],
    ] as const) {
      const app = await makeApp(actorContextFor(['owner']), rosterDeps([], () =>
        json({ code: 'PRIVATE_PROVIDER_DETAIL', message: 'secret account metadata' }, status)))
      try {
        const response = await app.inject({
          method: 'PUT', url: '/api/team/members/usr_grace/role', payload: { role: 'admin' },
        })
        assert.equal(response.statusCode, expectedStatus)
        assert.match(response.json().error.message, message)
        assert.doesNotMatch(response.body, /secret|PRIVATE_PROVIDER_DETAIL/)
      } finally {
        await app.close()
      }
    }
  })
})
