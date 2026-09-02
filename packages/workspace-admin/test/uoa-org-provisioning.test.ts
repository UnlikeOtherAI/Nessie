import assert from 'node:assert/strict'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'

import {
  createUoaOrganisation,
  createUoaWorkspaceTeam,
} from '../src/uoa-org-provisioning.js'
import { UoaRosterUnavailableError } from '../src/uoa-org-request.js'

/**
 * Creating a UOA organisation and workspace against the agreed contract. The
 * transport is stubbed through the same egress seam the routes inject; nothing
 * here reaches a live service.
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

const query = `?domain=nessie.test&config_url=${encodeURIComponent(uoaEnv.UOA_CONFIG_URL)}`

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
  body: unknown
  hasAccessToken: boolean
  hasSubjectAssertion: boolean
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Answers each call in order, so a fallback read can be scripted after a create. */
const deps = (calls: StubCall[], responses: Array<() => Response>) => ({
  fetchImpl: (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      hasAccessToken: headers.has('x-uoa-access-token'),
      hasSubjectAssertion: headers.has('x-uoa-subject-assertion'),
    })
    const next = responses.shift()
    assert.ok(next, 'an unexpected extra UOA call was made')
    return next()
  }) as PinnedFetch,
  // Egress is IP-pinned; stub DNS so the pinned transport still runs.
  resolveHost: async () => ['93.184.216.34'],
})

const createdOrg = (defaultTeam?: unknown) => ({
  id: 'org_new',
  domain: 'nessie.test',
  name: 'Acme Ltd',
  slug: 'acme-ltd',
  ownerId: 'uoa-sub-1',
  ...(defaultTeam === undefined ? {} : { defaultTeam }),
})

test('creating an organisation uses backend mode and returns the default workspace', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const workspace = await createUoaOrganisation(
      { name: 'Acme Ltd', ownerUoaSub: 'uoa-sub-1' },
      deps(calls, [() => json(createdOrg({ id: 'team_general', isDefault: true }))]),
    )

    assert.deepEqual(workspace, { externalOrgId: 'org_new', externalTeamId: 'team_general' })
    assert.equal(calls.length, 1, 'the defaultTeam field makes a follow-up read unnecessary')
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.url, `https://uoa.test/org/organisations${query}`)
    // Backend mode: the owner is named explicitly, and NEITHER user credential
    // is present. A subject assertion here would be refused upstream anyway —
    // it must name the org it acts on, which does not exist yet.
    assert.deepEqual(calls[0]?.body, { name: 'Acme Ltd', owner_user_id: 'uoa-sub-1' })
    assert.equal(calls[0]?.hasAccessToken, false)
    assert.equal(calls[0]?.hasSubjectAssertion, false)
  })
})

test('an assertion supplied by a caller is stripped, because create is backend mode', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await createUoaOrganisation(
      { name: 'Acme Ltd', ownerUoaSub: 'uoa-sub-1' },
      {
        ...deps(calls, [() => json(createdOrg({ id: 'team_general', isDefault: true }))]),
        subjectAssertion: 'a.b.c',
      },
    )
    assert.equal(calls[0]?.hasSubjectAssertion, false)
  })
})

test('an older UOA without defaultTeam falls back to reading the org teams', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const workspace = await createUoaOrganisation(
      { name: 'Acme Ltd', ownerUoaSub: 'uoa-sub-1' },
      deps(calls, [
        () => json(createdOrg()),
        () => json({
          data: [
            { id: 'team_other', isDefault: false },
            { id: 'team_general', isDefault: true },
          ],
        }),
      ]),
    )

    assert.deepEqual(workspace, { externalOrgId: 'org_new', externalTeamId: 'team_general' })
    assert.equal(calls[1]?.method, 'GET')
    assert.equal(calls[1]?.url, `https://uoa.test/org/organisations/org_new/teams${query}`)
    // The fallback is backend mode too — a user credential could not address
    // an organisation the caller has no session for.
    assert.equal(calls[1]?.hasAccessToken, false)
  })
})

test('the fallback accepts a lone team even when nothing is flagged default', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const workspace = await createUoaOrganisation(
      { name: 'Acme Ltd', ownerUoaSub: 'uoa-sub-1' },
      deps(calls, [
        () => json(createdOrg()),
        () => json({ data: [{ id: 'team_only' }] }),
      ]),
    )
    assert.equal(workspace.externalTeamId, 'team_only')
  })
})

test('an unresolvable default team fails naming the organisation that now exists', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      createUoaOrganisation(
        { name: 'Acme Ltd', ownerUoaSub: 'uoa-sub-1' },
        deps(calls, [() => json(createdOrg()), () => json({ data: [] })]),
      ),
      (error: unknown) => {
        assert.ok(error instanceof UoaRosterUnavailableError)
        // The organisation cannot be rolled back, so the id has to reach the
        // operator rather than being swallowed by a generic failure.
        assert.match(error.message, /org_new/)
        return true
      },
    )
  })
})

test('a create answered without an id is a failure, not a half-built workspace', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    await assert.rejects(
      createUoaOrganisation(
        { name: 'Acme Ltd', ownerUoaSub: 'uoa-sub-1' },
        deps(calls, [() => json({ name: 'Acme Ltd' })]),
      ),
      UoaRosterUnavailableError,
    )
    assert.equal(calls.length, 1, 'no team read is attempted without an organisation id')
  })
})

test('creating a workspace uses user mode and keeps the caller organisation', async () => {
  await withUoaEnv(async () => {
    const calls: StubCall[] = []
    const created = await createUoaWorkspaceTeam(
      { externalOrgId: 'org_acme', externalTeamId: 'team_current' },
      { name: 'Design' },
      {
        ...deps(calls, [() => json({ id: 'team_design', name: 'Design' })]),
        subjectAssertion: 'a.b.c',
      },
    )

    assert.deepEqual(created, { externalOrgId: 'org_acme', externalTeamId: 'team_design' })
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.url, `https://uoa.test/org/organisations/org_acme/teams${query}`)
    assert.deepEqual(calls[0]?.body, { name: 'Design' })
    // User mode, so UOA applies its own owner/admin gate and per-user limits.
    assert.equal(calls[0]?.hasSubjectAssertion, true)
  })
})
