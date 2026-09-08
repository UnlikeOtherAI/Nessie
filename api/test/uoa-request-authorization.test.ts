import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'
import { authorizeUoaRequest } from '../src/services/uoa-request-authorization.js'

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem', type: 'pkcs8',
})
Object.assign(process.env, {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKey).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
})

const identity = { organizationId: 'org_acme', subject: 'alice', teamId: 'team_one', tokenVersion: 1 }
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
})
const requestDeps = (fetchImpl: PinnedFetch) => ({
  fetchImpl, resolveHost: async () => ['93.184.216.34'],
})

test('org demotion uses a new signed UOA read on the very next request', async () => {
  let role = 'owner'
  let calls = 0
  const deps = requestDeps((async (url, init) => {
    calls += 1
    assert.equal(new URL(url).pathname, '/org/me')
    const headers = new Headers(init?.headers)
    assert.ok(headers.get('x-uoa-subject-assertion'))
    return json({ org: { org_id: 'org_acme', org_role: role } })
  }) as PinnedFetch)

  assert.deepEqual(await authorizeUoaRequest('org_acme', identity, deps), { status: 'allowed', role: 'owner' })
  role = 'member'
  assert.deepEqual(await authorizeUoaRequest('org_acme', identity, deps), { status: 'allowed', role: 'member' })
  assert.equal(calls, 2)
})

test('membership removal and deactivation reject a formerly authorized bearer', async () => {
  for (const status of [401, 403, 404]) {
    const deps = requestDeps((async () => json({ error: 'ACCESS_DENIED' }, status)) as PinnedFetch)
    assert.deepEqual(await authorizeUoaRequest('org_acme', identity, deps), { status: 'forbidden' })
  }
})

test('outages fail closed and a recovery is checked afresh', async () => {
  let status = 503
  const deps = requestDeps((async () => json({ org: { org_id: 'org_acme', org_role: 'admin' } }, status)) as PinnedFetch)
  assert.deepEqual(await authorizeUoaRequest('org_acme', identity, deps), { status: 'unavailable' })
  status = 200
  assert.deepEqual(await authorizeUoaRequest('org_acme', identity, deps), { status: 'allowed', role: 'admin' })
})

test('missing identity and cross-organisation credentials never reach UOA', async () => {
  const deps = requestDeps((async () => { throw new Error('must not call upstream') }) as PinnedFetch)
  assert.deepEqual(await authorizeUoaRequest('org_acme', undefined, deps), { status: 'forbidden' })
  assert.deepEqual(await authorizeUoaRequest('org_other', identity, deps), { status: 'forbidden' })
})

test('unknown roles and wrong organisation responses never recover local owner powers', async () => {
  for (const org of [
    { org_id: 'org_acme', org_role: 'unknown' },
    { org_id: 'org_other', org_role: 'owner' },
  ]) {
    const deps = requestDeps((async () => json({ org })) as PinnedFetch)
    assert.deepEqual(await authorizeUoaRequest('org_acme', identity, deps), { status: 'forbidden' })
  }
})
