import assert from 'node:assert/strict'
import test from 'node:test'
import { createECDH, generateKeyPairSync } from 'node:crypto'
import { WebPushClient, type WebPushFetch } from '../src/webpush.js'
import type { WebPushCredentials, WebPushTarget } from '../src/types.js'

const vapidCreds = (): WebPushCredentials => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string }
  const pub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, 'base64url'),
    Buffer.from(pubJwk.y, 'base64url'),
  ])
  return {
    publicKey: pub.toString('base64url'),
    privateKey: Buffer.from(privJwk.d, 'base64url').toString('base64url'),
    subject: 'mailto:ops@example.com',
  }
}

const target = (): WebPushTarget => {
  const ecdh = createECDH('prime256v1')
  const p256dh = ecdh.generateKeys()
  return {
    endpoint: 'https://fcm.googleapis.com/wp/abc123',
    p256dh: p256dh.toString('base64url'),
    auth: Buffer.from('0123456789abcdef').toString('base64url'),
  }
}

interface Call {
  url: string
  init: { method: string; headers: Record<string, string>; body: Buffer }
}

const scriptedFetch = (status: number, bodyText = ''): { fetch: WebPushFetch; calls: Call[] } => {
  const calls: Call[] = []
  const fetch: WebPushFetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({ status, text: () => Promise.resolve(bodyText) })
  }
  return { fetch, calls }
}

test('201 Created → ok', async () => {
  const { fetch } = scriptedFetch(201)
  const result = await new WebPushClient(vapidCreds(), fetch).send(target(), { title: 'T', body: 'B' })
  assert.deepEqual(result, { ok: true, status: 201, deadToken: false })
})

test('410 Gone → not ok, deadToken true', async () => {
  const { fetch } = scriptedFetch(410, 'gone')
  const result = await new WebPushClient(vapidCreds(), fetch).send(target(), { title: 'T', body: 'B' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 410)
  assert.equal(result.deadToken, true)
})

test('404 Not Found → deadToken true', async () => {
  const { fetch } = scriptedFetch(404)
  const result = await new WebPushClient(vapidCreds(), fetch).send(target(), { title: 'T', body: 'B' })
  assert.equal(result.deadToken, true)
})

test('429 Too Many Requests → not ok but NOT a dead token', async () => {
  const { fetch } = scriptedFetch(429, 'slow down')
  const result = await new WebPushClient(vapidCreds(), fetch).send(target(), { title: 'T', body: 'B' })
  assert.equal(result.ok, false)
  assert.equal(result.deadToken, false)
  assert.equal(result.error, 'slow down')
})

test('request carries VAPID auth, aes128gcm encoding, TTL and a binary body', async () => {
  const { fetch, calls } = scriptedFetch(201)
  const tgt = target()
  await new WebPushClient(vapidCreds(), fetch).send(tgt, { title: 'Hi', body: 'There' }, { ttlSeconds: 600 })

  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, tgt.endpoint)
  assert.equal(init.method, 'POST')
  assert.match(init.headers.authorization, /^vapid t=.+, k=.+$/)
  assert.equal(init.headers['content-encoding'], 'aes128gcm')
  assert.equal(init.headers['content-type'], 'application/octet-stream')
  assert.equal(init.headers.ttl, '600')
  assert.ok(Buffer.isBuffer(init.body))
  assert.ok(init.body.length > 86, 'body has header + ephemeral key + ciphertext')
})

test('network error → status 0, not a dead token', async () => {
  const fetch: WebPushFetch = () => Promise.reject(new Error('ECONNRESET'))
  const result = await new WebPushClient(vapidCreds(), fetch).send(target(), { title: 'T', body: 'B' })
  assert.equal(result.status, 0)
  assert.equal(result.deadToken, false)
  assert.match(result.error ?? '', /ECONNRESET/)
})

test('constructing with an invalid subject throws early', () => {
  assert.throws(() => new WebPushClient({ ...vapidCreds(), subject: 'nope' }), /mailto:.*https/)
})
