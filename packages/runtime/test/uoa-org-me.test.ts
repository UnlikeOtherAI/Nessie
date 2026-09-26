import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { readUoaOrgMe } from '../src/uoa-org-me.js'
import { UoaOrgRequestRejectedError } from '../src/uoa-org-request.js'

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs1' }).toString()

const settings = {
  authBaseUrl: 'https://uoa.example.test',
  clientSecret: 'secret',
  configUrl: 'https://nessie.example.test/config',
  kid: 'kid-1',
  privateKeyPem,
  sourceDomain: 'nessie.example.test',
}

const identity = {
  organizationId: 'uoa-org',
  subject: 'subject-1',
  teamId: 'uoa-team-a',
  tokenVersion: 4,
}

const answer = { org: { org_id: 'uoa-org', org_role: 'member', teams: ['uoa-team-a'] } }

const gate = (): { open: () => void; opened: Promise<void> } => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const deps = (fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>) => ({
  fetchImpl: fetchImpl as never,
  resolveHost: async () => ['8.8.8.8'] as never,
})

test('concurrent reads for one session share the single read in flight', async () => {
  const release = gate()
  let calls = 0
  const transport = deps(async (url, init) => {
    calls += 1
    assert.equal(url.pathname, '/org/me')
    assert.ok(new Headers(init?.headers).get('x-uoa-subject-assertion'))
    await release.opened
    return new Response(JSON.stringify(answer), { status: 200 })
  })

  const reads = Array.from({ length: 25 }, () => readUoaOrgMe(settings, identity, transport))
  release.open()

  for (const read of await Promise.all(reads)) assert.deepEqual(read, answer)
  assert.equal(calls, 1)
})

test('nothing outlives the read: one that starts after it settles asks UOA again', async () => {
  let calls = 0
  const transport = deps(async () => {
    calls += 1
    return new Response(JSON.stringify(answer), { status: 200 })
  })

  await readUoaOrgMe(settings, identity, transport)
  await readUoaOrgMe(settings, identity, transport)
  assert.equal(calls, 2)
})

test('a different subject, team or credential epoch never shares a read', async () => {
  const release = gate()
  const asked: string[] = []
  const transport = deps(async (_url, init) => {
    asked.push(String(new Headers(init?.headers).get('x-uoa-subject-assertion')))
    await release.opened
    return new Response(JSON.stringify(answer), { status: 200 })
  })

  const reads = [
    identity,
    { ...identity, subject: 'subject-2' },
    { ...identity, teamId: 'uoa-team-b' },
    { ...identity, tokenVersion: 5 },
  ].map((each) => readUoaOrgMe(settings, each, transport))
  release.open()
  await Promise.all(reads)

  assert.equal(asked.length, 4)
})

test('a refusal reaches every read that joined it and is not remembered', async () => {
  const release = gate()
  let status = 403
  let calls = 0
  const transport = deps(async () => {
    calls += 1
    await release.opened
    return new Response(JSON.stringify(status === 200 ? answer : { code: 'ACCESS_DENIED' }), { status })
  })

  const reads = Array.from({ length: 3 }, () => readUoaOrgMe(settings, identity, transport))
  release.open()
  for (const read of reads) await assert.rejects(read, UoaOrgRequestRejectedError)
  assert.equal(calls, 1)

  status = 200
  assert.deepEqual(await readUoaOrgMe(settings, identity, transport), answer)
  assert.equal(calls, 2)
})
