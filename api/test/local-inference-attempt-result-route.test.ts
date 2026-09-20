import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { signLocalInferenceEnvelope } from '@nessie/local-inference-host'
import type { LocalInferenceAttemptResultReceipt, LocalInferenceResult } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerLocalInferenceAttemptRoutes } from '../src/routes/local-inference-attempt-routes.js'

const attemptId = '00000000-0000-4000-8000-0000000000a1'
const hostId = '00000000-0000-4000-8000-0000000000a2'
const organizationId = '00000000-0000-4000-8000-0000000000a3'
const modelDigest = 'a'.repeat(64)
const keyPair = crypto.generateKeyPairSync('ed25519')
const machinePrivateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
const machinePublicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString()

type Attempt = {
  deadlineAt: Date
  dispatchFence: number
  modelDigest: string
  resultDigest: string | null
  state: 'accepted' | 'completed' | 'expired' | 'failed'
}

const result = (content: string, digest = modelDigest): LocalInferenceResult => ({
  capability: {
    discoveredAt: '2026-09-20T10:00:00.000Z',
    model: 'local:latest',
    provider: 'local_device',
    source: 'live',
    structuredOutputMode: 'text-only',
    supportsChat: true,
    supportsEmbeddings: false,
    supportsModelDiscovery: true,
    supportsStreaming: true,
    supportsVision: false,
    systemPromptMode: 'native',
    toolCallingMode: 'disabled',
    toolResultMode: 'native-tool-message',
    usageReporting: {
      cachedInputTokens: false,
      cachedOutputTokens: false,
      cacheReadTokens: false,
      cacheWriteTokens: false,
      inputTokens: true,
      outputTokens: true,
      providerReportedCost: false,
    },
  },
  content,
  finishReason: 'stop',
  modelDigest: digest,
  remoteHost: null,
  remoteModel: null,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
})

const makeApp = (deadlineAt: Date) => {
  let sequence = 0n
  const attempt: Attempt = {
    deadlineAt,
    dispatchFence: 1,
    modelDigest,
    resultDigest: null,
    state: 'accepted',
  }
  const tx = {
    $executeRaw: async () => 0,
    localInferenceAttempt: {
      findFirst: async () => ({ ...attempt }),
      updateMany: async ({ data, where }: {
        data: Partial<Attempt> & { encryptedResult?: Uint8Array; failureReason?: string; terminalAt?: Date }
        where: { state?: { in: string[] } }
      }) => {
        if (where.state && !where.state.in.includes(attempt.state)) return { count: 0 }
        Object.assign(attempt, data)
        return { count: 1 }
      },
    },
    localInferenceHostSequence: {
      findUnique: async () => sequence === 0n ? null : { lastSequence: sequence },
      upsert: async ({ create, update }: { create: { lastSequence: bigint }; update: { lastSequence: bigint } }) => {
        sequence = sequence === 0n ? create.lastSequence : update.lastSequence
      },
    },
  }
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    executor: { findFirst: async () => null },
    localInferenceHost: {
      findFirst: async () => ({
        connectionEpoch: 1,
        custodianUserId: '00000000-0000-4000-8000-0000000000a4',
        executorId: null,
        id: hostId,
        organizationId,
        publicKey: machinePublicKey,
        transport: 'desktop',
      }),
    },
  } as unknown as PrismaClient
  const app = Fastify({ logger: false })
  registerLocalInferenceAttemptRoutes(app, {
    encryptionKeyRing: { activeVersion: 'test', keys: { test: 'test-secret' } },
    prisma,
  } as never)
  let requestSequence = 0
  const submit = async (receiptResult: LocalInferenceResult) => {
    requestSequence += 1
    const receipt: LocalInferenceAttemptResultReceipt = {
      attemptId,
      dispatchFence: 1,
      result: receiptResult,
    }
    const envelope = signLocalInferenceEnvelope({
      body: receipt,
      header: {
        connectionEpoch: '1',
        hostId,
        organizationId,
        protocolVersion: 1,
        purpose: 'result',
        sentAt: new Date().toISOString(),
        sequence: requestSequence,
      },
      machinePrivateKey,
    })
    return app.inject({
      method: 'POST',
      payload: { envelope, receipt },
      url: '/api/local-inference/daemon/attempts/result',
    })
  }
  return { attempt, submit }
}

test('a late result is rejected and cannot resurrect the attempt', async () => {
  const state = makeApp(new Date(Date.now() - 1_000))
  const response = await state.submit(result('too late'))

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error.code, 'LOCAL_ATTEMPT_FENCED')
  assert.equal(state.attempt.state, 'expired')
})

test('a result for a different model digest is rejected', async () => {
  const state = makeApp(new Date(Date.now() + 60_000))
  const response = await state.submit(result('wrong model', 'b'.repeat(64)))

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error.code, 'LOCAL_ATTEMPT_FENCED')
  assert.equal(state.attempt.state, 'failed')
})

test('an exact terminal receipt replay is acknowledged', async () => {
  const state = makeApp(new Date(Date.now() + 60_000))
  const first = await state.submit(result('stable answer'))
  const replay = await state.submit(result('stable answer'))

  assert.equal(first.statusCode, 200)
  assert.equal(replay.statusCode, 200)
  assert.equal(state.attempt.state, 'completed')
})

test('a conflicting terminal receipt replay is rejected', async () => {
  const state = makeApp(new Date(Date.now() + 60_000))
  const first = await state.submit(result('first answer'))
  const conflict = await state.submit(result('changed answer'))

  assert.equal(first.statusCode, 200)
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().error.code, 'LOCAL_ATTEMPT_FENCED')
  assert.equal(state.attempt.state, 'completed')
})
