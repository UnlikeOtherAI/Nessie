import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CodingSessionBrokerError,
  createCodingSessionBroker,
} from '../src/coding-session-broker.js'
import { startExecutorEgressGateway } from '../src/egress-gateway.js'

const proof = (byte: number): string => Buffer.alloc(32, byte).toString('base64url')

const throughGateway = async (input: {
  body?: string
  headers?: Record<string, string>
  method: string
  path: string
  socketPath: string
}): Promise<{ body: string; headers: Record<string, string | string[] | undefined>; status: number }> => (
  new Promise((resolvePromise, reject) => {
    const client = request({
      headers: input.headers,
      method: input.method,
      path: input.path,
      socketPath: input.socketPath,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => resolvePromise({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        status: response.statusCode ?? 0,
      }))
    })
    client.once('error', reject)
    client.end(input.body)
  })
)

test('coding session broker exposes only scoped, expiring proxy tokens', () => {
  let now = 1_000_000
  const generated = [proof(1), proof(2), proof(3)]
  const broker = createCodingSessionBroker({ provider: 'openai', secret: 'sk-local-provider-secret' }, {
    now: () => now,
    randomToken: () => generated.shift() ?? proof(9),
  })
  assert.equal(broker.sessionProof, proof(1))
  const clientToken = broker.issueClientToken(broker.sessionProof)
  assert.equal(clientToken, proof(2))
  assert.equal(clientToken?.includes('sk-local-provider-secret'), false)
  assert.deepEqual(broker.authorize(clientToken!), {
    headers: { authorization: 'Bearer sk-local-provider-secret' },
    provider: 'openai',
  })
  now += 45_001
  assert.equal(broker.authorize(clientToken!), undefined)
  assert.equal(broker.issueClientToken(proof(8)), undefined)
  const replacement = broker.issueClientToken(broker.sessionProof)
  assert.equal(replacement, proof(3))
  broker.revoke()
  assert.equal(broker.authorize(replacement!), undefined)
  assert.equal(broker.issueClientToken(broker.sessionProof), undefined)
})

test('coding session broker rejects malformed credentials and unsafe lifetimes', () => {
  assert.throws(
    () => createCodingSessionBroker({ provider: 'openai', secret: ' leading-space' }),
    CodingSessionBrokerError,
  )
  assert.throws(
    () => createCodingSessionBroker({ provider: 'anthropic', secret: 'key' }, { lifetimeMs: 59_999 }),
    CodingSessionBrokerError,
  )
})

test('the private egress gateway exchanges a session proof then injects provider auth only at its fixed origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-executor-coding-broker-'))
  const socketPath = join(directory, 'egress.sock')
  await chmod(directory, 0o700)
  const broker = createCodingSessionBroker({ provider: 'openai', secret: 'sk-never-leaves-companion' })
  let calls = 0
  const gateway = await startExecutorEgressGateway({
    codingBroker: broker,
    policy: { allowedOrigins: ['https://app.example.test'] },
    socketPath,
  }, {
    pinnedFetch: async (url, init) => {
      calls += 1
      assert.equal(url.toString(), 'https://api.openai.com/v1/responses')
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sk-never-leaves-companion')
      assert.equal(new Headers(init.headers).get('x-nessie-session-proof'), null)
      const requestBody = await new Response(init.body).text()
      if (requestBody === '{"redirect":true}') {
        return new Response(null, {
          headers: { location: 'https://redirect-target.invalid/credential-exfiltration' },
          status: 302,
        })
      }
      assert.equal(requestBody, '{"model":"gpt-test"}')
      return new Response('{"id":"resp_1"}', {
        headers: { 'content-type': 'application/json', 'set-cookie': 'not-forwarded' },
        status: 200,
      })
    },
  })
  try {
    const issued = await throughGateway({
      headers: { 'x-nessie-session-proof': broker.sessionProof },
      method: 'GET',
      path: '/.nessie/coding-credential',
      socketPath,
    })
    assert.equal(issued.status, 200)
    const clientToken = issued.body.trim()
    assert.match(clientToken, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(issued.body.includes('sk-never-leaves-companion'), false)

    const forwarded = await throughGateway({
      body: '{"model":"gpt-test"}',
      headers: {
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
        'x-nessie-session-proof': broker.sessionProof,
      },
      method: 'POST',
      path: '/v1/responses',
      socketPath,
    })
    assert.equal(forwarded.status, 200)
    assert.equal(forwarded.body, '{"id":"resp_1"}')
    assert.equal(forwarded.headers['set-cookie'], undefined)
    assert.equal(calls, 1)

    const redirected = await throughGateway({
      body: '{"redirect":true}',
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
      method: 'POST',
      path: '/v1/responses',
      socketPath,
    })
    assert.equal(redirected.status, 502)
    assert.equal(calls, 2)

    const blocked = await throughGateway({
      body: '{"model":"gpt-test"}',
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
      method: 'POST',
      path: '/v1/files',
      socketPath,
    })
    assert.equal(blocked.status, 403)
    assert.equal(calls, 2)

    broker.revoke()
    const revoked = await throughGateway({
      body: '{"model":"gpt-test"}',
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
      method: 'POST',
      path: '/v1/responses',
      socketPath,
    })
    assert.equal(revoked.status, 403)
    assert.equal(calls, 2)
  } finally {
    await gateway.close()
    await rm(directory, { force: true, recursive: true })
  }
})
