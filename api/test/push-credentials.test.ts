import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { ApnsCredentials, PushPayload, PushResult, PushTarget } from '@nessie/push'

import { createPushCredentialsService } from '../src/services/push-credentials.js'

const p8 = (): string => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return privateKey as string
}

const service = (options: { apnsSender?: typeof sentApns } = {}) => {
  const prisma = {
    pushCredential: {
      findUnique: async () => ({
        provider: 'apns',
        secretRef: 'secret_push_apns',
        apnsKeyId: 'KEY123',
        apnsTeamId: 'TEAM123',
        apnsTopic: 'com.km.nessie',
        apnsEnvironment: 'sandbox',
      }),
    },
  } as unknown as PrismaClient
  return createPushCredentialsService({
    prisma,
    secretStore: {
      put: async () => 'unused',
      remove: async () => undefined,
      resolve: async () => p8(),
    },
    apnsSender: options.apnsSender,
  })
}

const sentApns = async (
  _credentials: ApnsCredentials,
  _target: PushTarget,
  _payload: PushPayload,
): Promise<PushResult> => ({ ok: true, status: 200, deadToken: false })

test('APNs test sends the standard alert directly to the registered device', async () => {
  let received: { credentials: ApnsCredentials; target: PushTarget; payload: PushPayload } | null = null
  const apnsSender = async (
    credentials: ApnsCredentials,
    target: PushTarget,
    payload: PushPayload,
  ): Promise<PushResult> => {
    received = { credentials, target, payload }
    return { ok: true, status: 200, deadToken: false }
  }

  const result = await service({ apnsSender }).test({
    provider: 'apns',
    deviceToken: 'apns-device-token',
  })

  assert.deepEqual(result, {
    ok: true,
    message: 'APNs accepted the test notification.',
    delivered: true,
  })
  assert.equal(received?.credentials.topic, 'com.km.nessie')
  assert.deepEqual(received?.target, { token: 'apns-device-token' })
  assert.deepEqual(received?.payload, {
    title: 'Nessie push is connected',
    body: 'This test was sent directly from your Nessie server.',
    data: { url: '/settings/push' },
    collapseId: 'nessie-apns-test',
  })
})

test('APNs test requires a registered iOS device before it claims delivery', async () => {
  let calls = 0
  const result = await service({
    apnsSender: async (): Promise<PushResult> => {
      calls += 1
      return { ok: true, status: 200, deadToken: false }
    },
  }).test({ provider: 'apns' })

  assert.deepEqual(result, {
    ok: false,
    message: 'No iOS device is registered for your current team.',
    delivered: false,
  })
  assert.equal(calls, 0)
})
