import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'

import { updateUoaTeamIdentity } from '../src/uoa-org-profile.js'

/**
 * A team's name and its address are one write, to the place that owns them.
 *
 * The address is UOA's `slug` — the team's DNS label. It goes through the same
 * `PUT` as the rename on purpose: UOA validates the label there, refuses a bad
 * or taken one with a reason rather than coercing it, and answers with what it
 * stored. These hold the two things a caller can get wrong: sending a field
 * that was not asked for, and trusting the requested value over UOA's echo.
 */

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

const team = { externalOrgId: 'org_acme', externalTeamId: 'team_general' } as never

const capture = (payload: unknown) => {
  const sent: { body?: string; method?: string; url: string }[] = []
  return {
    sent,
    deps: {
      fetchImpl: (async (url: URL, init) => {
        sent.push({
          url: url.toString(),
          method: init?.method ?? 'GET',
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        })
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as PinnedFetch,
      resolveHost: async () => ['93.184.216.34'],
    },
  }
}

test('only the fields asked for are sent, so a rename is not also an address change', async () => {
  await withUoaEnv(async () => {
    const { deps, sent } = capture({ name: 'General' })
    await updateUoaTeamIdentity(team, { name: 'General' }, deps as never)
    assert.equal(sent[0]?.method, 'PUT')
    assert.deepEqual(JSON.parse(sent[0]?.body ?? '{}'), { name: 'General' })
  })
})

test('an address change is a PUT to the team, carrying the slug', async () => {
  await withUoaEnv(async () => {
    const { deps, sent } = capture({ name: 'General', slug: 'unlikeotherai' })
    const stored = await updateUoaTeamIdentity(
      team,
      { name: 'General', slug: 'unlikeotherai' },
      deps as never,
    )
    assert.deepEqual(JSON.parse(sent[0]?.body ?? '{}'), { name: 'General', slug: 'unlikeotherai' })
    assert.match(sent[0]?.url ?? '', /\/org\/organisations\/org_acme\/teams\/team_general/u)
    assert.deepEqual(stored, { name: 'General', slug: 'unlikeotherai' })
  })
})

test('what UnlikeOtherAI stored wins over what was requested', async () => {
  await withUoaEnv(async () => {
    // UOA normalizes: the caller asked for one thing and it kept another.
    const { deps } = capture({ name: 'General', slug: 'unlike-other-ai' })
    const stored = await updateUoaTeamIdentity(
      team,
      { name: 'General', slug: 'Unlike Other AI' },
      deps as never,
    )
    assert.equal(stored.slug, 'unlike-other-ai', 'the echo is the authority, never the request')
  })
})

test('a response with no slug reads as null rather than echoing the request back', async () => {
  await withUoaEnv(async () => {
    const { deps } = capture({ name: 'General' })
    const stored = await updateUoaTeamIdentity(team, { name: 'General' }, deps as never)
    assert.equal(stored.slug, null)
  })
})
