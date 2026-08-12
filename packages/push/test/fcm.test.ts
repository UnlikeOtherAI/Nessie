import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import {
  buildFcmBody,
  FcmClient,
  parseServiceAccount,
} from '../src/fcm.js'
import type { FetchLike, FetchLikeResponse } from '../src/transport.js'
import type { FcmCredentials } from '../src/types.js'

const serviceAccountJson = (): string => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  return JSON.stringify({
    type: 'service_account',
    project_id: 'proj-123',
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: pem,
    token_uri: 'https://oauth2.googleapis.com/token',
  })
}

const creds = (): FcmCredentials => ({ serviceAccountJson: serviceAccountJson() })

const jsonResponse = (status: number, body: unknown): FetchLikeResponse => ({
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
})

interface Call {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

const scriptedFetch = (
  responses: (call: Call) => FetchLikeResponse,
): { fetch: FetchLike; calls: Call[] } => {
  const calls: Call[] = []
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(responses({ url, init }))
  }
  return { fetch: fetchImpl, calls }
}

const tokenOk = jsonResponse(200, { access_token: 'at-1', expires_in: 3600 })

test('parseServiceAccount extracts fields and defaults token_uri', () => {
  const json = JSON.stringify({
    project_id: 'p',
    client_email: 'e',
    private_key: 'k',
  })
  const acct = parseServiceAccount(json)
  assert.equal(acct.projectId, 'p')
  assert.equal(acct.clientEmail, 'e')
  assert.equal(acct.privateKey, 'k')
  assert.equal(acct.tokenUri, 'https://oauth2.googleapis.com/token')
})

test('parseServiceAccount throws on missing project_id', () => {
  assert.throws(
    () => parseServiceAccount(JSON.stringify({ client_email: 'e', private_key: 'k' })),
    /project_id/,
  )
})

test('parseServiceAccount throws on invalid JSON', () => {
  assert.throws(() => parseServiceAccount('{nope'), /could not be parsed/)
})

test('buildFcmBody combines the subtitle into Android notification title', () => {
  const body = JSON.parse(
    buildFcmBody('dev-token', {
      title: 'Hi',
      subtitle: '# General',
      body: 'There',
      data: { url: 'nessie://x' },
      badge: 7,
      collapseId: 'chan-1',
    }),
  )
  assert.deepEqual(body, {
    message: {
      token: 'dev-token',
      notification: { title: 'Hi · # General', body: 'There' },
      data: { url: 'nessie://x' },
      android: { collapse_key: 'chan-1', notification: { notification_count: 7 } },
      apns: {
        headers: { 'apns-collapse-id': 'chan-1' },
        payload: { aps: { badge: 7 }, body: { url: 'nessie://x' } },
      },
    },
  })
})

test('200 send → ok with message name as messageId', async () => {
  const { fetch, calls } = scriptedFetch((call) =>
    call.url.endsWith('/token')
      ? tokenOk
      : jsonResponse(200, { name: 'projects/proj-123/messages/0:abc' }),
  )
  const result = await new FcmClient(creds(), fetch).send(
    { token: 'dev' },
    { title: 'T', body: 'B' },
  )
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    deadToken: false,
    messageId: 'projects/proj-123/messages/0:abc',
  })
  // token exchange + send
  assert.equal(calls.length, 2)
  const send = calls[1]
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/proj-123/messages:send')
  assert.equal(send.init.headers.authorization, 'Bearer at-1')
})

test('UNREGISTERED → deadToken true', async () => {
  const { fetch } = scriptedFetch((call) =>
    call.url.endsWith('/token')
      ? tokenOk
      : jsonResponse(404, { error: { status: 'UNREGISTERED', message: 'gone' } }),
  )
  const result = await new FcmClient(creds(), fetch).send(
    { token: 'dev' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.deadToken, true)
  assert.equal(result.error, 'UNREGISTERED')
})

test('INVALID_ARGUMENT → deadToken true', async () => {
  const { fetch } = scriptedFetch((call) =>
    call.url.endsWith('/token')
      ? tokenOk
      : jsonResponse(400, { error: { status: 'INVALID_ARGUMENT' } }),
  )
  const result = await new FcmClient(creds(), fetch).send(
    { token: 'dev' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.deadToken, true)
})

test('other error → ok false, not dead', async () => {
  const { fetch } = scriptedFetch((call) =>
    call.url.endsWith('/token')
      ? tokenOk
      : jsonResponse(500, { error: { status: 'INTERNAL' } }),
  )
  const result = await new FcmClient(creds(), fetch).send(
    { token: 'dev' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.deadToken, false)
  assert.equal(result.error, 'INTERNAL')
})

test('access token is cached across sends and reused until expiry', async () => {
  let clock = 1_000_000
  const { fetch, calls } = scriptedFetch((call) =>
    call.url.endsWith('/token')
      ? jsonResponse(200, { access_token: 'at-X', expires_in: 3600 })
      : jsonResponse(200, { name: 'm' }),
  )
  const client = new FcmClient(creds(), fetch, () => clock)

  await client.send({ token: 'a' }, { title: 'T', body: 'B' })
  await client.send({ token: 'b' }, { title: 'T', body: 'B' })

  const tokenCalls = calls.filter((c) => c.url.endsWith('/token'))
  assert.equal(tokenCalls.length, 1) // exchanged once, reused

  clock += 3600 * 1000 // past expiry
  await client.send({ token: 'c' }, { title: 'T', body: 'B' })
  assert.equal(calls.filter((c) => c.url.endsWith('/token')).length, 2)
})

test('token exchange failure → ok false, status 0', async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(401, { error: { status: 'UNAUTHENTICATED', message: 'bad jwt' } }),
  )
  const result = await new FcmClient(creds(), fetch).send(
    { token: 'dev' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
  assert.equal(result.deadToken, false)
  assert.match(result.error ?? '', /token exchange failed/)
})
