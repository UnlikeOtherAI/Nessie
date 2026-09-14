import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readNativePushRegistration,
  shouldRegisterNativePush,
} from '../src/lib/native-push-registration.js'
import { registerNativePush } from '../src/lib/native-push-ownership.js'

const eventWithDetail = (detail: unknown): Event => ({ detail }) as unknown as Event

test('accepts a structurally valid native APNs registration', () => {
  assert.deepEqual(
    readNativePushRegistration(eventWithDetail({
      platform: 'ios',
      token: 'apns-device-token',
      appVersion: '0.1.0',
    })),
    {
      platform: 'ios',
      token: 'apns-device-token',
      appVersion: '0.1.0',
    },
  )
})

test('rejects malformed native bridge payloads', () => {
  assert.equal(readNativePushRegistration(eventWithDetail({ platform: 'ios' })), null)
  assert.equal(readNativePushRegistration(eventWithDetail({ platform: 'web', token: 'x' })), null)
})

test('native push registration is disabled for imported debug sessions', () => {
  assert.equal(shouldRegisterNativePush(true, 'renewable'), true)
  assert.equal(shouldRegisterNativePush(true, 'imported'), false)
  assert.equal(shouldRegisterNativePush(false, 'renewable'), false)
})

test('a native WebView carries its recovery key and persisted proofs through legacy re-enrolment and switching', async () => {
  const ownershipProofs = [
    'first-installation-proof-is-long-enough',
    'transferred-installation-proof-is-long-enough',
    'revived-installation-proof-is-long-enough',
  ]
  const sent: Array<Record<string, unknown>> = []
  const stored = new Map<string, string>()
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  }
  const apiClient = {
    post: async (path: string, body: Record<string, unknown>) => {
      assert.equal(path, '/api/devices')
      sent.push(body)
      return { ownershipProof: ownershipProofs[sent.length - 1] }
    },
  }
  const registration = { platform: 'ios' as const, token: 'physical-installation-token' }

  await registerNativePush(apiClient, registration, storage)
  await registerNativePush(apiClient, registration, storage)
  await registerNativePush(apiClient, registration, storage)

  const recoveryKey = sent[0]?.['deviceRecoveryKey']
  assert.equal(typeof recoveryKey, 'string')
  assert.deepEqual(sent, [
    { ...registration, deviceRecoveryKey: recoveryKey },
    { ...registration, deviceRecoveryKey: recoveryKey, ownershipProof: ownershipProofs[0] },
    { ...registration, deviceRecoveryKey: recoveryKey, ownershipProof: ownershipProofs[1] },
  ])
  assert.equal(
    stored.get('nessie:native-push-ownership:physical-installation-token'),
    ownershipProofs[2],
  )
  assert.equal(
    stored.get('nessie:native-push-recovery:physical-installation-token'),
    recoveryKey,
  )
})

test('a lost proof response keeps the installed recovery key for the retry', async () => {
  const sent: Array<Record<string, unknown>> = []
  const stored = new Map<string, string>()
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  }
  const apiClient = {
    post: async (_path: string, body: Record<string, unknown>) => {
      sent.push(body)
      if (sent.length === 1) throw new Error('response lost after registration committed')
      return { ownershipProof: 'replacement-proof-after-lost-response-is-long-enough' }
    },
  }
  const registration = { platform: 'android' as const, token: 'lost-response-installation-token' }

  await assert.rejects(registerNativePush(apiClient, registration, storage))
  await registerNativePush(apiClient, registration, storage)

  assert.equal(sent.length, 2)
  assert.equal(sent[1]?.['deviceRecoveryKey'], sent[0]?.['deviceRecoveryKey'])
  assert.equal(typeof sent[0]?.['deviceRecoveryKey'], 'string')
  assert.equal(
    stored.get('nessie:native-push-ownership:lost-response-installation-token'),
    'replacement-proof-after-lost-response-is-long-enough',
  )
})
