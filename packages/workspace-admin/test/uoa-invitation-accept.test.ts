import assert from 'node:assert/strict'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'

import {
  acceptWorkspaceInvitation,
  UoaInvitationOrgConflictError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
} from '../src/uoa-org-roster.js'

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
  body?: string
  hasAccessToken: boolean
  method: string
  url: string
}

const deps = (calls: StubCall[], respond: () => Response) => ({
  fetchImpl: (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      body: typeof init?.body === 'string' ? init.body : undefined,
      hasAccessToken: headers.has('x-uoa-access-token'),
      method: init?.method ?? 'GET',
      url: url.toString(),
    })
    return respond()
  }) as PinnedFetch,
  resolveHost: async () => ['93.184.216.34'],
})

const workspace = { externalOrgId: 'org/acme', externalTeamId: 'team/design' }

test('acceptWorkspaceInvitation posts the subject in backend mode', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await acceptWorkspaceInvitation(
      workspace,
      'invite/1',
      'uoa-subject',
      deps(calls, () => new Response(JSON.stringify({
        ok: true,
        orgId: workspace.externalOrgId,
        teamId: workspace.externalTeamId,
      }), { status: 200 })),
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.hasAccessToken, false)
    assert.match(calls[0]?.url ?? '', /organisations\/org%2Facme\/teams\/team%2Fdesign\/invitations\/invite%2F1\/accept\?/)
    assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { userId: 'uoa-subject' })
  })
})

test('the named UOA domain conflict has its own typed error', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      acceptWorkspaceInvitation(
        workspace,
        'invite-1',
        'uoa-subject',
        deps(calls, () => new Response(
          JSON.stringify({ code: 'ORG_CONFLICT_ON_DOMAIN' }),
          { status: 400 },
        )),
      ),
      UoaInvitationOrgConflictError,
    )
  })
})

test('other 4xx retain their status and upstream code', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      acceptWorkspaceInvitation(
        workspace,
        'invite-1',
        'uoa-subject',
        deps(calls, () => new Response(JSON.stringify({ code: 'INVITE_EXPIRED' }), {
          status: 409,
        })),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UoaRosterRejectedError)
        assert.equal(error.statusCode, 409)
        assert.equal(error.upstreamCode, 'INVITE_EXPIRED')
        return true
      },
    )
  })
})

test('an unreadable or contradictory 200 response is an outage', async () => {
  await withUoaEnv(async () => {
    for (const response of [
      new Response('', { status: 200 }),
      new Response('<html>gateway</html>', { status: 200 }),
      new Response(JSON.stringify({ ok: false }), { status: 200 }),
      new Response(JSON.stringify({
        ok: true,
        orgId: 'another-org',
        teamId: workspace.externalTeamId,
      }), { status: 200 }),
    ]) {
      await assert.rejects(
        acceptWorkspaceInvitation(
          workspace,
          'invite-1',
          'uoa-subject',
          deps([], () => response),
        ),
        UoaRosterUnavailableError,
      )
    }
  })
})
