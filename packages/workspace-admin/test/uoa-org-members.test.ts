import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'

import {
  listOrganisationMembers,
  updateOrganisationMemberRole,
  withUoaOrgRosterSubjectAssertion,
} from '../src/uoa-org-members.js'
import {
  UoaRosterIdentityError,
  UoaRosterRejectedError,
} from '../src/uoa-org-roster.js'

/**
 * `listOrganisationMembers` / `updateOrganisationMemberRole` against the
 * agreed UOA contract (`/org/organisations/:orgId/members`, backend mode) —
 * the ORG-wide roster, with no team join. The transport is stubbed through
 * the same egress seam the routes inject; nothing here reaches a live service.
 * Mirrors `uoa-invitation-revoke.test.ts`'s harness.
 */

// A real key: the subject-assertion test below signs a JWT for real.
const uoaPrivateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(uoaPrivateKeyPem).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

const externalOrgId = 'org_acme'

const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`

const membersUrl = `https://uoa.test/org/organisations/${externalOrgId}/members${query}&status=all`

// The caller passes the already-encoded segment (the source escapes it).
const memberUrl = (encodedSub: string): string =>
  `https://uoa.test/org/organisations/${externalOrgId}/members/${encodedSub}${query}`

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
  body?: string
}

const deps = (calls: StubCall[], respond: () => Response | Promise<Response>) => ({
  fetchImpl: (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
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

const orgMembers = {
  data: [
    { userId: 'usr_ada', email: 'ada@acme.test', name: 'Ada Lovelace', role: 'owner', status: 'ACTIVE' },
    {
      userId: 'usr_grace',
      email: 'grace@acme.test',
      name: 'Grace Hopper',
      role: 'member',
      status: 'DEACTIVATED',
    },
    // A row with no subject is not a member — it must not become one.
    { role: 'member' },
  ],
  next_cursor: null,
}

test('listOrganisationMembers reads the whole org roster with no team in the path', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const members = await listOrganisationMembers(externalOrgId, deps(calls, () => json(orgMembers)))

    assert.deepEqual(members, [
      {
        uoaSub: 'usr_ada',
        displayName: 'Ada Lovelace',
        email: 'ada@acme.test',
        orgRole: 'owner',
        status: 'ACTIVE',
      },
      {
        uoaSub: 'usr_grace',
        displayName: 'Grace Hopper',
        email: 'grace@acme.test',
        orgRole: 'member',
        status: 'DEACTIVATED',
      },
    ])

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'GET')
    assert.equal(calls[0]?.url, membersUrl)
    // One read, and it is the ORG path: no `/teams/` anywhere, which is the
    // whole point — the team roster is a different function.
    assert.ok(!calls[0]?.url.includes('/teams/'))
    assert.match(calls[0]?.authorization ?? '', /^Bearer [0-9a-f]{64}$/)
  })
})

test('updateOrganisationMemberRole PUTs the org role for one subject', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await updateOrganisationMemberRole(
      externalOrgId,
      'usr_grace',
      'admin',
      deps(calls, () => json({ ok: true })),
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.method, 'PUT')
    assert.equal(calls[0]?.url, memberUrl('usr_grace'))
    assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { role: 'admin' })
  })
})

test('the subject in a role change is escaped rather than pasted into the path', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await updateOrganisationMemberRole(
      externalOrgId,
      'usr/grace?x',
      'member',
      deps(calls, () => json({ ok: true })),
    )

    assert.equal(calls[0]?.url, memberUrl('usr%2Fgrace%3Fx'))
  })
})

test('a UOA refusal surfaces as a rejected error with its status', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      updateOrganisationMemberRole(
        externalOrgId,
        'usr_gone',
        'admin',
        deps(calls, () => json({ error: 'member_not_found' }, 404)),
      ),
      (error: unknown) =>
        error instanceof UoaRosterRejectedError && error.statusCode === 404,
    )
  })
})

test('the org-scoped subject assertion requires the session org, not a team', async () => {
  await withUoaEnv(async () => {
    // The session's team being anywhere in this org is enough — there is no
    // single team to match in an org-scoped call, unlike the team-roster
    // sibling `withUoaRosterSubjectAssertion`.
    const depsWithAssertion = withUoaOrgRosterSubjectAssertion(externalOrgId, {
      organizationId: externalOrgId,
      subject: 'usr_ada',
      teamId: 'team_anything_in_this_org',
      tokenVersion: 7,
    })
    assert.ok(depsWithAssertion.subjectAssertion)

    // A session for another organisation is refused.
    assert.throws(
      () =>
        withUoaOrgRosterSubjectAssertion(externalOrgId, {
          organizationId: 'org_other',
          subject: 'usr_ada',
          teamId: 'team_design',
          tokenVersion: 7,
        }),
      UoaRosterIdentityError,
    )
    // And so is no identity at all.
    assert.throws(
      () => withUoaOrgRosterSubjectAssertion(externalOrgId, undefined),
      UoaRosterIdentityError,
    )
  })
})
