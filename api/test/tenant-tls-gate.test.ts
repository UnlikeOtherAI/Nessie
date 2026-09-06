import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify, { type FastifyInstance } from 'fastify'

// The roster client builds its settings from the environment at call time, so
// this has to be in place before the route module is imported.
process.env.UOA_DOMAIN ??= 'api.example.test'
process.env.UOA_CONFIG_URL ??= 'https://api.example.test/api/auth/sso/config'
process.env.UOA_JWKS_URL ??= 'https://api.example.test/.well-known/jwks.json'
process.env.UOA_REDIRECT_URL ??= 'https://app.example.test/login'
process.env.UOA_CONFIG_JWT_KID ??= 'test-kid'
process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 ??= Buffer.from('not-a-real-key').toString('base64')
// Without a client secret the roster client reports itself unconfigured and
// never dials, so every answer would be "unavailable" rather than the refusals
// and admissions this file is about.
process.env.UOA_CLIENT_SECRET ??= 'test-client-secret'

const { registerTeamProvisioningRoutes } = await import('../src/routes/team-provisioning.js')

const KEY = 'gate-key-for-tests'
const BASE = 'nessie.test'

/**
 * What UOA is pretending to hold. `/domain/organisations/resolve` answers for
 * `acme`; `/domain/teams/resolve` answers only for `design` inside it.
 */
const uoaFetch = (calls: string[]) => async (url: URL): Promise<Response> => {
  calls.push(url.pathname)
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (url.pathname === '/domain/organisations/resolve') {
    return url.searchParams.get('org') === 'acme'
      ? json(200, { ok: true, org_id: 'org_1', org_name: 'Acme', org_slug: 'acme' })
      : json(404, { ok: false, error: 'NOT_FOUND' })
  }
  if (url.pathname === '/domain/teams/resolve') {
    return url.searchParams.get('team') === 'design' && url.searchParams.get('org') === 'acme'
      ? json(200, { ok: true, team_id: 'team_1', org_id: 'org_1' })
      : json(404, { ok: false, error: 'NOT_FOUND' })
  }
  return json(404, { ok: false, error: 'NOT_FOUND' })
}

// `configured: false` rather than `key: undefined`, because a default parameter
// substitutes for an explicitly passed undefined and the unconfigured case
// would silently get the key.
const buildApp = (
  { configured = true, calls = [] as string[] } = {},
): FastifyInstance => {
  const app = Fastify({ logger: false })
  registerTeamProvisioningRoutes(
    app,
    {
      prisma: {} as never,
      requireActorContext: () => null,
      requireUserActor: () => false,
      teamHostBaseDomain: BASE,
      tlsCheckKey: configured ? KEY : undefined,
    } as never,
    {
      fetchImpl: uoaFetch(calls) as never,
      // safeFetch pins the connection to resolved addresses before it dials, so
      // a test host that resolves nowhere would fail before the stub is reached.
      // A public address: the SSRF guard refuses private and reserved ranges
      // before the transport is ever reached.
      resolveHost: (async () => ['93.184.216.34']) as never,
    },
  )
  return app
}

const ask = async (app: FastifyInstance, query: string) =>
  app.inject({ method: 'GET', url: `/api/hosts/tls-check?${query}` })

test('a real organisation host may be issued a certificate', async () => {
  const app = buildApp()
  try {
    assert.equal((await ask(app, `domain=acme.${BASE}&key=${KEY}`)).statusCode, 204)
  } finally {
    await app.close()
  }
})

test('a real team host may be issued a certificate', async () => {
  const app = buildApp()
  try {
    assert.equal((await ask(app, `domain=design.acme.${BASE}&key=${KEY}`)).statusCode, 204)
  } finally {
    await app.close()
  }
})

test('a made-up team label inside a real organisation is refused', async () => {
  // This is the whole reason the gate is not wired to /api/hosts/resolve, which
  // answers `kind: "team"` here because it verifies only the organisation. A
  // certificate for every guessed label would exhaust Let's Encrypt's weekly
  // allowance for the entire base domain.
  const calls: string[] = []
  const app = buildApp({ calls })
  try {
    assert.equal((await ask(app, `domain=nope.acme.${BASE}&key=${KEY}`)).statusCode, 404)
    assert.ok(
      calls.includes('/domain/teams/resolve'),
      'the team label must actually be checked, not assumed from the organisation',
    )
  } finally {
    await app.close()
  }
})

test('an unknown organisation is refused', async () => {
  const app = buildApp()
  try {
    assert.equal((await ask(app, `domain=nobody.${BASE}&key=${KEY}`)).statusCode, 404)
  } finally {
    await app.close()
  }
})

test('a hostname outside the base domain is refused before UOA is asked', async () => {
  const calls: string[] = []
  const app = buildApp({ calls })
  try {
    // Ends with the base domain but is a different registrable domain.
    assert.equal((await ask(app, `domain=acme.evil-${BASE}&key=${KEY}`)).statusCode, 404)
    // Three labels deep is not a shape this product serves.
    assert.equal((await ask(app, `domain=a.b.c.${BASE}&key=${KEY}`)).statusCode, 404)
    assert.deepEqual(calls, [], 'a hostname that is not ours must cost no UOA round trip')
  } finally {
    await app.close()
  }
})

test('the wrong key is refused, and so is no key', async () => {
  const app = buildApp()
  try {
    assert.equal((await ask(app, `domain=acme.${BASE}&key=wrong`)).statusCode, 404)
    assert.equal((await ask(app, `domain=acme.${BASE}`)).statusCode, 404)
  } finally {
    await app.close()
  }
})

test('an install with no key configured refuses everything', async () => {
  // Fail closed: it cannot be turned into a "does this team exist" oracle, and
  // on-demand issuance simply does not happen there.
  const app = buildApp({ configured: false })
  try {
    assert.equal((await ask(app, `domain=acme.${BASE}&key=${KEY}`)).statusCode, 404)
    assert.equal((await ask(app, `domain=design.acme.${BASE}`)).statusCode, 404)
  } finally {
    await app.close()
  }
})

test('every refusal looks the same from outside', async () => {
  const app = buildApp()
  try {
    const cases = [
      `domain=acme.${BASE}&key=wrong`,
      `domain=nobody.${BASE}&key=${KEY}`,
      `domain=nope.acme.${BASE}&key=${KEY}`,
      `domain=acme.somewhere.else&key=${KEY}`,
    ]
    for (const query of cases) {
      const response = await ask(app, query)
      assert.equal(response.statusCode, 404, query)
      assert.equal(response.body, '', `${query} must not say why`)
    }
  } finally {
    await app.close()
  }
})
