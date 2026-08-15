import assert from 'node:assert/strict'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'

import {
  revokeTeamInvitation,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
} from '../src/uoa-org-roster.js'

/**
 * `revokeTeamInvitation` against the agreed UOA contract
 * (`DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId`,
 * backend mode). The transport is stubbed through the same egress seam the
 * routes inject; nothing here reaches a live service.
 */

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from('unused').toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

const workspace = { externalOrgId: 'org_acme', externalTeamId: 'team_design' }

const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`

const revokeUrl = (inviteId: string): string =>
  `https://uoa.test/org/organisations/${workspace.externalOrgId}`
  + `/teams/${workspace.externalTeamId}/invitations/${inviteId}${query}`

const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, uoaEnv)
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

type StubCall = {
  url: string
  method: string
  authorization?: string
  hasAccessToken: boolean
}

const deps = (calls: StubCall[], respond: () => Response | Promise<Response>) => ({
  fetchImpl: (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      hasAccessToken: headers.has('x-uoa-access-token'),
    })
    return respond()
  }) as PinnedFetch,
  // Egress is IP-pinned; stub DNS so the pinned transport still runs.
  resolveHost: async () => ['93.184.216.34'],
})

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('a revoke deletes the team invitation in backend mode', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await revokeTeamInvitation(workspace, 'inv_1', deps(calls, () => json({ ok: true })))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'DELETE')
    assert.equal(calls[0]?.url, revokeUrl('inv_1'))
    // Backend mode is the domain-hash bearer with the access token absent in
    // every form — a blank header is a malformed credential upstream.
    assert.match(calls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
    assert.equal(calls[0]?.hasAccessToken, false)
  })
})

test('the invite id is escaped rather than pasted into the path', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await revokeTeamInvitation(workspace, 'inv/1?x', deps(calls, () => json({ ok: true })))

    assert.equal(calls[0]?.url, revokeUrl('inv%2F1%3Fx'))
  })
})

test('revoking an already-revoked invitation is a success, not an error', async () => {
  await withUoaEnv(async () => {
    // UOA's delete is idempotent: the second click reaches the same state, so
    // the person is told it worked rather than that something went wrong.
    const calls: StubCall[] = []
    await revokeTeamInvitation(workspace, 'inv_1', deps(calls, () => json({ ok: true })))
    await revokeTeamInvitation(workspace, 'inv_1', deps(calls, () => json({ ok: true })))
    assert.equal(calls.length, 2)

    // An empty 200 body is still a success — there is nothing to contradict it.
    await revokeTeamInvitation(
      workspace,
      'inv_1',
      deps(calls, () => new Response('', { status: 200 })),
    )
  })
})

test('an accepted invitation maps to its own error, not a generic refusal', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      revokeTeamInvitation(
        workspace,
        'inv_taken',
        deps(calls, () => json({ error: 'invitation_already_accepted' }, 409)),
      ),
      (error: unknown) => {
        // The route answers 409 INVITATION_ALREADY_ACCEPTED off this type, so a
        // generic rejection here would become an indistinguishable 400.
        assert.ok(error instanceof UoaInvitationAlreadyAcceptedError)
        assert.ok(!(error instanceof UoaRosterRejectedError))
        return true
      },
    )
  })
})

test('an unknown or foreign invitation stays a plain 404 refusal', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      revokeTeamInvitation(
        workspace,
        'inv_ghost',
        deps(calls, () => json({ error: 'not_found' }, 404)),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UoaRosterRejectedError)
        assert.equal(error.statusCode, 404)
        return true
      },
    )
  })
})

test('a transport failure or unusable answer is an outage, never a silent revoke', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const unavailable = (error: unknown) => {
      assert.ok(error instanceof UoaRosterUnavailableError)
      return true
    }

    await assert.rejects(
      revokeTeamInvitation(
        workspace,
        'inv_1',
        deps(calls, () => {
          throw new Error('connection reset')
        }),
      ),
      unavailable,
    )
    await assert.rejects(
      revokeTeamInvitation(
        workspace,
        'inv_1',
        deps(calls, () => new Response('boom', { status: 503 })),
      ),
      unavailable,
    )
    await assert.rejects(
      revokeTeamInvitation(
        workspace,
        'inv_1',
        deps(calls, () => new Response('<html>gateway</html>', { status: 200 })),
      ),
      unavailable,
    )
    // A 200 whose body contradicts success is not evidence the invite is gone.
    await assert.rejects(
      revokeTeamInvitation(workspace, 'inv_1', deps(calls, () => json({ ok: false }))),
      unavailable,
    )
  })
})

test('an unconfigured deployment refuses before any egress', async () => {
  const previous = process.env.UOA_DOMAIN
  delete process.env.UOA_DOMAIN
  try {
    await assert.rejects(
      revokeTeamInvitation(workspace, 'inv_1', {
        fetchImpl: (async () => {
          assert.fail('an unconfigured deployment must not call UOA')
        }) as unknown as PinnedFetch,
        resolveHost: async () => ['93.184.216.34'],
      }),
      (error: unknown) => error instanceof UoaRosterUnavailableError,
    )
  } finally {
    if (previous === undefined) delete process.env.UOA_DOMAIN
    else process.env.UOA_DOMAIN = previous
  }
})
