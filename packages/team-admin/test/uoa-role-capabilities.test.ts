import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'

import {
  readUoaOrganizationRoleContext,
  uoaRoleHoldsCapability,
} from '../src/uoa-role-capabilities.js'
import { UoaRosterRejectedError } from '../src/uoa-org-roster.js'

const privateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(privateKeyPem).toString('base64'),
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

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('the shared resolver keeps owner structural and unknown roles fail closed', () => {
  const grants = { org: { administrator: ['nessie.organisation.manage'] } }

  assert.equal(uoaRoleHoldsCapability(grants, 'org', 'owner', 'nessie.organisation.manage'), true)
  assert.equal(uoaRoleHoldsCapability(grants, 'org', 'administrator', 'nessie.organisation.manage'), true)
  assert.equal(uoaRoleHoldsCapability(grants, 'org', 'member', 'nessie.organisation.manage'), false)
  assert.equal(uoaRoleHoldsCapability(grants, 'org', 'unrecognised', 'nessie.organisation.manage'), false)
})

test('the live UOA context must name the exact requested organisation', async () => {
  await withUoaEnv(async () => {
    const calls: URL[] = []
    const deps = {
      fetchImpl: (async (url: URL) => {
        calls.push(url)
        return json({ ok: true, org: { org_id: 'org_acme', org_role: 'administrator' } })
      }) as PinnedFetch,
      resolveHost: async () => ['93.184.216.34'],
    }

    const context = await readUoaOrganizationRoleContext('org_acme', deps)
    assert.deepEqual(context, { organizationId: 'org_acme', role: 'administrator' })
    assert.equal(calls[0]?.pathname, '/org/me')
  })
})

test('a different UOA organisation is a refusal, never a local fallback', async () => {
  await withUoaEnv(async () => {
    await assert.rejects(
      readUoaOrganizationRoleContext('org_acme', {
        fetchImpl: (async () => json({ ok: true, org: { org_id: 'org_other', org_role: 'owner' } })) as PinnedFetch,
        resolveHost: async () => ['93.184.216.34'],
      }),
      UoaRosterRejectedError,
    )
  })
})
