import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  clearConnectors,
  hasConnector,
  listIncrementalPollingConnectors,
} from '@nessie/comms-connect'
import { registerCommsConnectorsFromEnv } from '../src/index.js'

beforeEach(() => {
  clearConnectors()
})

test('registers nothing when no provider env is set', () => {
  const registered = registerCommsConnectorsFromEnv({})
  assert.deepEqual(registered, [])
  assert.equal(hasConnector('slack'), false)
  assert.equal(hasConnector('google'), false)
  assert.equal(hasConnector('microsoft'), false)
})

test('registers Slack only when all three secrets are present', () => {
  const partial = registerCommsConnectorsFromEnv({
    NESSIE_COMMS_SLACK_CLIENT_ID: 'id',
    NESSIE_COMMS_SLACK_CLIENT_SECRET: 'secret',
    // signing secret missing → not registered
  })
  assert.deepEqual(partial, [])
  assert.equal(hasConnector('slack'), false)

  const registered = registerCommsConnectorsFromEnv({
    NESSIE_COMMS_SLACK_CLIENT_ID: 'id',
    NESSIE_COMMS_SLACK_CLIENT_SECRET: 'secret',
    NESSIE_COMMS_SLACK_SIGNING_SECRET: 'signing',
  })
  assert.deepEqual(registered, ['slack'])
  assert.equal(hasConnector('slack'), true)
})

test('registers Google when client id + secret are present (pubsub optional)', () => {
  const registered = registerCommsConnectorsFromEnv({
    NESSIE_COMMS_GOOGLE_CLIENT_ID: 'id',
    NESSIE_COMMS_GOOGLE_CLIENT_SECRET: 'secret',
  })
  assert.deepEqual(registered, ['google'])
  assert.equal(hasConnector('google'), true)
  assert.deepEqual(listIncrementalPollingConnectors(), [{
    provider: 'google',
    intervalMs: 5 * 60 * 1000,
  }])
})

test('registers Microsoft with PKCE client id (client secret optional)', () => {
  const registered = registerCommsConnectorsFromEnv({
    NESSIE_COMMS_MICROSOFT_CLIENT_ID: 'microsoft-id',
  })
  assert.deepEqual(registered, ['microsoft'])
  assert.equal(hasConnector('microsoft'), true)
})

test('registers both providers together and never throws on missing env', () => {
  const registered = registerCommsConnectorsFromEnv({
    NESSIE_COMMS_SLACK_CLIENT_ID: 'id',
    NESSIE_COMMS_SLACK_CLIENT_SECRET: 'secret',
    NESSIE_COMMS_SLACK_SIGNING_SECRET: 'signing',
    NESSIE_COMMS_GOOGLE_CLIENT_ID: 'gid',
    NESSIE_COMMS_GOOGLE_CLIENT_SECRET: 'gsecret',
    NESSIE_COMMS_GOOGLE_PUBSUB_TOPIC: 'projects/p/topics/t',
    NESSIE_COMMS_MICROSOFT_CLIENT_ID: 'mid',
    NESSIE_COMMS_MICROSOFT_CLIENT_SECRET: 'msecret',
  })
  assert.deepEqual(registered.sort(), ['google', 'microsoft', 'slack'])
  assert.equal(hasConnector('slack'), true)
  assert.equal(hasConnector('google'), true)
  assert.equal(hasConnector('microsoft'), true)
})
