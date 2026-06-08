import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGatewayApp } from '../src/app.js'
import type {
  GatewayConfig,
  GatewayPushResponse,
  GatewaySender,
} from '../src/types.js'
import type { PushPayload, PushResult, PushTarget } from '@nessie/push'

interface SentCall {
  target: PushTarget
  payload: PushPayload
}

const config = (overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  apiKey: 'secret',
  host: '127.0.0.1',
  port: 5556,
  apns: {
    p8: 'p8',
    keyId: 'kid',
    teamId: 'team',
    topic: 'com.example.nessie',
    environment: 'sandbox',
  },
  fcm: {
    serviceAccountJson: '{}',
  },
  ...overrides,
})

const result = (overrides: Partial<PushResult> = {}): PushResult => ({
  ok: true,
  status: 200,
  deadToken: false,
  ...overrides,
})

const fakeSender = () => {
  const calls = {
    apns: [] as SentCall[],
    fcm: [] as SentCall[],
  }
  const sender: GatewaySender = {
    sendApns: (target, payload) => {
      calls.apns.push({ target, payload })
      return Promise.resolve(result({ messageId: 'apns-1' }))
    },
    sendFcm: (target, payload) => {
      calls.fcm.push({ target, payload })
      return Promise.resolve(result({ ok: false, status: 404, deadToken: true, error: 'UNREGISTERED' }))
    },
  }
  return { sender, calls }
}

test('POST /v1/push routes iOS to APNs and Android to FCM', async () => {
  const { sender, calls } = fakeSender()
  const app = buildGatewayApp({ config: config(), sender, logger: false })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/push',
    headers: { authorization: 'Bearer secret' },
    payload: {
      targets: [
        { token: 'ios-token', platform: 'ios' },
        { token: 'android-token', platform: 'android' },
      ],
      payload: {
        title: 'Mention',
        body: 'Ada mentioned you',
        badge: 2,
        collapseId: 'channel-1',
        data: { deepLink: 'nessie://channels/1' },
      },
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(calls.apns, [
    {
      target: { token: 'ios-token' },
      payload: {
        title: 'Mention',
        body: 'Ada mentioned you',
        badge: 2,
        collapseId: 'channel-1',
        data: { deepLink: 'nessie://channels/1' },
      },
    },
  ])
  assert.equal(calls.fcm.length, 1)
  assert.deepEqual(calls.fcm[0]?.target, { token: 'android-token' })

  const body = response.json() as GatewayPushResponse
  assert.deepEqual(body, {
    results: [
      { token: 'ios-token', ok: true, deadToken: false },
      { token: 'android-token', ok: false, deadToken: true, error: 'UNREGISTERED' },
    ],
  })
  await app.close()
})

test('POST /v1/push rejects missing or wrong bearer token', async () => {
  const { sender, calls } = fakeSender()
  const app = buildGatewayApp({ config: config(), sender, logger: false })
  const missing = await app.inject({
    method: 'POST',
    url: '/v1/push',
    payload: { targets: [], payload: { title: 'T', body: 'B' } },
  })
  const wrong = await app.inject({
    method: 'POST',
    url: '/v1/push',
    headers: { authorization: 'Bearer wrong' },
    payload: { targets: [], payload: { title: 'T', body: 'B' } },
  })

  assert.equal(missing.statusCode, 401)
  assert.equal(wrong.statusCode, 401)
  assert.equal(calls.apns.length, 0)
  assert.equal(calls.fcm.length, 0)
  await app.close()
})

test('POST /v1/push reports provider not configured without sending', async () => {
  const { sender, calls } = fakeSender()
  const app = buildGatewayApp({
    config: config({ apns: undefined, fcm: undefined }),
    sender,
    logger: false,
  })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/push',
    headers: { authorization: 'Bearer secret' },
    payload: {
      targets: [
        { token: 'ios-token', platform: 'ios' },
        { token: 'android-token', platform: 'android' },
      ],
      payload: { title: 'T', body: 'B' },
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    results: [
      { token: 'ios-token', ok: false, deadToken: false, error: 'APNs is not configured' },
      { token: 'android-token', ok: false, deadToken: false, error: 'FCM is not configured' },
    ],
  })
  assert.equal(calls.apns.length, 0)
  assert.equal(calls.fcm.length, 0)
  await app.close()
})

test('GET /health returns ok', async () => {
  const { sender } = fakeSender()
  const app = buildGatewayApp({ config: config(), sender, logger: false })
  const response = await app.inject({ method: 'GET', url: '/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ok: true })
  await app.close()
})
