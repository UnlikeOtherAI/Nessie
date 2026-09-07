import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import { canonicalExecutorPayload, type ExecutorDaemonControlType } from '@nessie/executor-manage'
import { canonicalExecutorJson } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerGlobalAuthHook } from '../src/lib/global-auth-hook.js'
import { registerBrowserCookieImportRoutes } from '../src/routes/browser-cookie-imports.js'

const executorId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const origin = 'https://example.test'
const now = (): string => new Date().toISOString()

type ImportState = 'pending' | 'importing' | 'imported'

const protocolHarness = (connectionEpoch = '7') => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  let imports = 0
  let authenticateCalls = 0
  let state: ImportState = 'pending'
  const row = {
    actorId: 'user-1',
    agent: { name: 'Private agent' },
    agentId: 'agent-1',
    createdAt: new Date(),
    executor: {
      organizationId: 'org-1', pairingOwnerUserId: 'user-1', scopeKind: 'private',
    },
    executorId,
    expiresAt: new Date(Date.now() + 60_000),
    id: requestId,
    organizationId: 'org-1',
    origins: [origin],
    threadId: 'thread-1',
  }
  const prisma = {
    $executeRaw: async (): Promise<number> => 1,
    $transaction: async <Result>(action: (tx: unknown) => Promise<Result>): Promise<Result> => action(prisma),
    browserCookieImport: {
      findFirst: async (input: { where: { id?: string; state: ImportState } }) => {
        if (input.where.id && input.where.id !== requestId) return null
        return input.where.state === state ? row : null
      },
      update: async (input: { data: { state?: ImportState } }) => {
        if (input.data.state) state = input.data.state
        return row
      },
      updateMany: async (input: { data: { state?: ImportState }; where: { state: ImportState } }) => {
        if (input.where.state !== state) return { count: 0 }
        if (input.data.state) state = input.data.state
        return { count: 1 }
      },
    },
    executor: {
      findUnique: async () => ({
        activeConnectionEpoch: BigInt(connectionEpoch),
        id: executorId,
        lastSeenAt: new Date(),
        machinePublicKey: publicDer.subarray(-32).toString('base64url'),
        status: 'online',
      }),
      update: async () => ({ id: executorId }),
      updateMany: async () => ({ count: 0 }),
    },
  }
  const signature = (
    type: ExecutorDaemonControlType,
    payload: Record<string, unknown>,
  ): string => sign(
    null,
    Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.${type}.v1`, payload)),
    privateKey,
  ).toString('base64url')
  return {
    app: Fastify(),
    imports: () => imports,
    prisma,
    signature,
    state: () => state,
    authenticateCalls: () => authenticateCalls,
    authenticate: async () => { authenticateCalls += 1 },
    importer: async () => { imports += 1 },
  }
}

const signedPoll = (
  harness: ReturnType<typeof protocolHarness>,
  epoch = '7',
) => {
  const observedAt = now()
  const payload = { connectionEpoch: epoch, executorId, observedAt }
  return { ...payload, signature: harness.signature('browser_cookie_import.poll', payload) }
}

const signedUpload = (
  harness: ReturnType<typeof protocolHarness>,
  epoch = '7',
) => {
  const submittedAt = now()
  const cookies = {
    imports: [{
      cookies: [{
        domain: 'example.test', hostOnly: true, httpOnly: true, name: 'session', path: '/',
        sameSite: 'lax', secure: true, session: true, value: 'synthetic-cookie-value',
      }],
      origin,
    }],
    version: 1 as const,
  }
  const payloadDigest = `sha256:${createHash('sha256').update(canonicalExecutorJson(cookies)).digest('hex')}`
  const payload = {
    connectionEpoch: epoch, cookies, executorId, payloadDigest, requestId,
    selectedOrigins: [origin], submittedAt,
  }
  return { ...payload, signature: harness.signature('browser_cookie_import.upload', payload) }
}

const appWithProtocol = async (harness: ReturnType<typeof protocolHarness>) => {
  registerGlobalAuthHook(harness.app, {
    authenticateRequest: harness.authenticate,
    config: { api: { rateLimit: {} } } as never,
    prisma: harness.prisma,
    rateLimiter: { guard: async () => ({ allowed: true }) } as never,
  } as never)
  registerBrowserCookieImportRoutes(harness.app, {
    authSecret: 'test-auth-secret-for-cookie-import-protocol',
    browserCookieImporter: harness.importer,
    prisma: harness.prisma,
    privateImportTargetLoader: async () => ({ agentName: 'Private agent', agentOwnerUserId: 'user-1' }),
  } as never)
  await harness.app.ready()
  return harness.app
}

test('signed cookie import daemon calls bypass global session auth and can be used once', async () => {
  const harness = protocolHarness()
  const app = await appWithProtocol(harness)
  try {
    const poll = await app.inject({
      method: 'POST', url: '/api/executor-daemon/browser-cookie-imports/pending', payload: signedPoll(harness),
    })
    assert.equal(poll.statusCode, 200)
    assert.equal(poll.json().data.offer.requestId, requestId)
    assert.equal(harness.authenticateCalls(), 0)

    const first = await app.inject({
      method: 'POST', url: '/api/executor-daemon/browser-cookie-imports/upload', payload: signedUpload(harness),
    })
    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.json().data, { status: 'imported' })
    assert.equal(first.body.includes('synthetic-cookie-value'), false)
    assert.equal(harness.imports(), 1)
    assert.equal(harness.state(), 'imported')

    const replay = await app.inject({
      method: 'POST', url: '/api/executor-daemon/browser-cookie-imports/upload', payload: signedUpload(harness),
    })
    assert.equal(replay.statusCode, 409)
    assert.equal(replay.json().error.code, 'BROWSER_COOKIE_IMPORT_UNAVAILABLE')
    assert.equal(harness.imports(), 1)
    assert.equal(harness.authenticateCalls(), 0)
  } finally {
    await app.close()
  }
})

test('a signed import request from a fenced connection epoch is refused', async () => {
  const harness = protocolHarness('8')
  const app = await appWithProtocol(harness)
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/executor-daemon/browser-cookie-imports/pending', payload: signedPoll(harness, '7'),
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error.code, 'EXECUTOR_CONNECTION_FENCED')
    assert.equal(harness.authenticateCalls(), 0)
  } finally {
    await app.close()
  }
})
