import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { sealLocalInferenceAttempt } from '@nessie/runtime'
import { signLocalInferenceEnvelope } from '@nessie/local-inference-host'
import { registerLocalInferenceAttemptRoutes } from '../src/routes/local-inference-attempt-routes.js'

test('a committed poll replays its exact admission, including a paused no-invoke fence', async (t) => {
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const hostId = randomUUID()
  const organizationId = randomUUID()
  const requestId = randomUUID()
  const attemptId = randomUUID()
  const keyRing = { activeVersion: 'fixture', keys: { fixture: 'fixture-secret' } }
  const admission = { id: randomUUID(), attemptId, fence: randomUUID(), resourceId: randomUUID(), state: 'running' }
  let paused = false
  let sequence = 0n
  const host = { id: hostId, organizationId, publicKey, connectionEpoch: 1, executorId: null, transport: 'desktop' }
  const tx = {
    $executeRaw: async () => 0,
    localInferenceHost: { findFirst: async () => paused ? null : host },
    localInferenceResource: { findUnique: async () => ({ pausedAt: paused ? new Date() : null, healthReason: null }) },
    inferenceResourceAdmission: { findUnique: async () => admission },
    localInferenceAttempt: {
      findUnique: async ({ where }: { where: { pollRequestId: string } }) => {
        assert.equal(where.pollRequestId, requestId)
        return {
          id: attemptId, hostId, resourceAdmissionId: admission.id, dispatchFence: 3,
          encryptedRequest: sealLocalInferenceAttempt(keyRing, { attemptId }),
        }
      },
      findMany: async () => { throw new Error('A replay must never select another queued attempt.') },
    },
    localInferenceHostSequence: {
      findUnique: async () => sequence ? { lastSequence: sequence } : null,
      upsert: async ({ create }: { create: { lastSequence: bigint } }) => { sequence = create.lastSequence },
    },
  }
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    executor: { findFirst: async () => null },
    localInferenceHost: { findFirst: async () => host },
  }
  const app = Fastify()
  t.after(() => app.close())
  registerLocalInferenceAttemptRoutes(app, { prisma, encryptionKeyRing: keyRing } as never)
  const poll = { requestId }
  const request = (number: number) => app.inject({
    method: 'POST', url: '/api/local-inference/daemon/attempts/poll',
    payload: {
      poll,
      envelope: signLocalInferenceEnvelope({
        body: poll, machinePrivateKey: privateKey,
        header: {
          connectionEpoch: '1', hostId, organizationId, protocolVersion: 1, purpose: 'poll',
          sentAt: new Date().toISOString(), sequence: number,
        },
      }),
    },
  })
  const first = await request(1)
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json().data, {
    admission: { admissionId: admission.id, fence: admission.fence, resourceId: admission.resourceId },
    attempt: { attemptId }, dispatchFence: 3,
  })
  const repeated = await request(2)
  assert.deepEqual(repeated.json().data, first.json().data)
  paused = true
  const draining = await request(3)
  assert.equal(draining.statusCode, 200)
  assert.equal(draining.json().data.dispatchFence, null)
  assert.deepEqual(draining.json().data.admission, first.json().data.admission)
})
