import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { ApnsClient, buildApnsBody } from '../src/apns.js'
import type {
  ApnsTransport,
  Http2Request,
  Http2Response,
} from '../src/transport.js'
import type { ApnsCredentials } from '../src/types.js'

const p256Pem = (): string => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
}

const creds = (): ApnsCredentials => ({
  p8: p256Pem(),
  keyId: 'KEY123',
  teamId: 'TEAM456',
  topic: 'com.example.app',
  environment: 'sandbox',
})

class FakeTransport implements ApnsTransport {
  requests: Http2Request[] = []
  closed = false
  constructor(private readonly responder: (req: Http2Request) => Http2Response) {}
  send(request: Http2Request): Promise<Http2Response> {
    this.requests.push(request)
    return Promise.resolve(this.responder(request))
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

test('buildApnsBody puts routing data in Expo\'s remote userInfo.body envelope', () => {
  const body = JSON.parse(
    buildApnsBody({
      title: 'Hi',
      subtitle: '# General',
      body: 'There',
      badge: 3,
      collapseId: 'chan-1',
      data: { url: 'nessie://channels/1' },
    }),
  )
  assert.deepEqual(body, {
    aps: {
      alert: { title: 'Hi', subtitle: '# General', body: 'There' },
      badge: 3,
      'thread-id': 'chan-1',
    },
    body: { url: 'nessie://channels/1' },
  })
})

test('200 response → ok with apns-id messageId, headers set correctly', async () => {
  const transport = new FakeTransport(() => ({ status: 200, apnsId: 'apns-9', body: '' }))
  const client = new ApnsClient(creds(), () => transport)
  const result = await client.send(
    { token: 'devtoken' },
    { title: 'T', body: 'B', collapseId: 'c1' },
  )
  assert.deepEqual(result, { ok: true, status: 200, deadToken: false, messageId: 'apns-9' })

  const req = transport.requests[0]
  assert.equal(req.path, '/3/device/devtoken')
  assert.match(req.headers.authorization, /^bearer /)
  assert.equal(req.headers['apns-topic'], 'com.example.app')
  assert.equal(req.headers['apns-push-type'], 'alert')
  assert.equal(req.headers['apns-collapse-id'], 'c1')
})

test('410 response → deadToken true', async () => {
  const transport = new FakeTransport(() => ({
    status: 410,
    body: JSON.stringify({ reason: 'Unregistered' }),
  }))
  const result = await new ApnsClient(creds(), () => transport).send(
    { token: 't' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.status, 410)
  assert.equal(result.deadToken, true)
  assert.equal(result.error, 'Unregistered')
})

test('400 BadDeviceToken → deadToken true', async () => {
  const transport = new FakeTransport(() => ({
    status: 400,
    body: JSON.stringify({ reason: 'BadDeviceToken' }),
  }))
  const result = await new ApnsClient(creds(), () => transport).send(
    { token: 't' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.deadToken, true)
  assert.equal(result.error, 'BadDeviceToken')
})

test('other 4xx → ok false, not dead', async () => {
  const transport = new FakeTransport(() => ({
    status: 403,
    body: JSON.stringify({ reason: 'InvalidProviderToken' }),
  }))
  const result = await new ApnsClient(creds(), () => transport).send(
    { token: 't' },
    { title: 'T', body: 'B' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.deadToken, false)
  assert.equal(result.error, 'InvalidProviderToken')
})

test('transport throw → ok false, status 0', async () => {
  const transport: ApnsTransport = {
    send: () => Promise.reject(new Error('socket down')),
    close: () => Promise.resolve(),
  }
  const result = await new ApnsClient(creds(), () => transport).send(
    { token: 't' },
    { title: 'T', body: 'B' },
  )
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    deadToken: false,
    error: 'socket down',
  })
})

test('auth JWT is cached and re-minted after the TTL', async () => {
  let clock = 1_000_000
  const transport = new FakeTransport(() => ({ status: 200, body: '' }))
  const client = new ApnsClient(creds(), () => transport, () => clock)

  await client.send({ token: 'a' }, { title: 'T', body: 'B' })
  const first = transport.requests[0].headers.authorization

  clock += 5 * 60 * 1000 // within TTL
  await client.send({ token: 'b' }, { title: 'T', body: 'B' })
  assert.equal(transport.requests[1].headers.authorization, first)

  clock += 20 * 60 * 1000 // past 20-min TTL
  await client.send({ token: 'c' }, { title: 'T', body: 'B' })
  assert.notEqual(transport.requests[2].headers.authorization, first)
})

test('close tears down the transport session', async () => {
  const transport = new FakeTransport(() => ({ status: 200, body: '' }))
  const client = new ApnsClient(creds(), () => transport)
  await client.send({ token: 't' }, { title: 'T', body: 'B' })
  await client.close()
  assert.equal(transport.closed, true)
})
