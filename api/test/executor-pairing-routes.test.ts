import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import { rateLimitKeyHash } from '@nessie/db'
import { registerExecutorPairingCodeRoutes } from '../src/routes/executor-pairing-codes.js'
import type { RouteDeps } from '../src/routes/types.js'
import { canonicalizeIpIdentity } from '../src/services/rate-limit-identity.js'

const actor = AuthorizedActionContextSchema.parse({
  actor: { actorType: 'user', actorId: randomUUID() }, tenant: { organizationId: randomUUID() },
  actionContext: { requestId: randomUUID() },
})
const appFor = (prisma: PrismaClient) => {
  const app = Fastify()
  registerExecutorPairingCodeRoutes(app, {
    prisma, authSecret: 'route test secret',
    requireActorContext: () => actor, requireUserActor: () => true,
  } as unknown as RouteDeps)
  return app
}

test('eight-digit pairing fails closed when the distributed rate store is unavailable', async () => {
  const app = appFor({ $queryRaw: async () => { throw new Error('database down') } } as unknown as PrismaClient)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/executor-pairing/start', payload: {} })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().error.code, 'EXECUTOR_PAIRING_UNAVAILABLE')
  } finally { await app.close() }
})

const dbTest = process.env.DATABASE_URL ? test : test.skip
dbTest('pairing guesses share source and account budgets across replicas, before input parsing', async () => {
  const first = new PrismaClient()
  const second = new PrismaClient()
  const apps = [appFor(first), appFor(second)]
  const source = `2001:db8:${randomInt(1, 65535).toString(16)}:${randomInt(1, 65535).toString(16)}::1`
  const hashes: string[] = []
  const hit = async (path: string, ip: string, replica: number) => apps[replica]!.inject({
    method: 'POST', url: path, payload: {}, remoteAddress: ip,
  })
  try {
    hashes.push(rateLimitKeyHash('executor.pairing.mint', `ip:${canonicalizeIpIdentity(source)}`))
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await hit('/api/executor-pairing/start', source, index % 2)).statusCode, 400)
    }
    const blocked = await hit('/api/executor-pairing/start', source.replace('::1', '::ffff'), 1)
    assert.equal(blocked.statusCode, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)
    hashes.push(rateLimitKeyHash('executor.pairing.lookup', `account:${actor.actor.actorId}`))
    for (let index = 0; index < 11; index += 1) {
      const uniqueSource = `2001:db8:${randomInt(1, 65535).toString(16)}:${randomInt(1, 65535).toString(16)}::1`
      hashes.push(rateLimitKeyHash('executor.pairing.lookup', `ip:${canonicalizeIpIdentity(uniqueSource)}`))
      const response = await hit(index % 2 ? '/api/executor-pairing/claim' : '/api/executor-pairing/preview',
        uniqueSource, index % 2)
      assert.equal(response.statusCode, index < 10 ? 400 : 429)
    }
  } finally {
    await Promise.all(apps.map((app) => app.close()))
    await first.rateLimitBucket.deleteMany({ where: { keyHash: { in: hashes } } })
    await Promise.all([first.$disconnect(), second.$disconnect()])
  }
})
