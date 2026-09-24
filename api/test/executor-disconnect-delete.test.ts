import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import { registerExecutorRoutes } from '../src/routes/executors.js'
import type { RouteDeps } from '../src/routes/types.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/** Prepares a lifecycle change and confirms it the way the admin does: token only, no password. */
const applyLifecycle = async (app: FastifyInstance, executorId: string, action: 'revoke' | 'remove') => {
  const prepared = await app.inject({
    method: 'POST', url: '/api/executor-access-changes',
    payload: { executorId, change: { kind: 'lifecycle', action } },
  })
  assert.equal(prepared.statusCode, 200, prepared.body)
  const { accessChangeId, confirmationToken, requiresFreshVerification } = prepared.json().data
  assert.equal(requiresFreshVerification, false, `${action} must not ask for a fresh identity check`)
  const confirmed = await app.inject({
    method: 'POST', url: `/api/executor-access-changes/${accessChangeId}/confirm`,
    payload: { confirmationToken },
  })
  assert.equal(confirmed.statusCode, 200, confirmed.body)
}

const listedIds = async (app: FastifyInstance): Promise<string[]> => {
  const listed = await app.inject({ method: 'GET', url: '/api/executors' })
  assert.equal(listed.statusCode, 200, listed.body)
  return (listed.json().data as { id: string }[]).map((executor) => executor.id)
}

dbTest('an account without a password disconnects an executor, then deletes it from every people-facing read', async () => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()
  const pairedId = randomUUID()
  const pendingId = randomUUID()
  const actor = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })
  const app = Fastify()
  registerExecutorRoutes(app, {
    prisma, requireActorContext: () => actor, requireUserActor: () => true,
  } as unknown as RouteDeps)
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Executor delete test' } })
    // An SSO account: no password hash, so no fresh factor can be checked.
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Owner' } })
    await prisma.organizationMember.create({ data: { organizationId, userId, role: 'owner' } })
    await prisma.executor.createMany({ data: [
      { id: pairedId, organizationId, label: 'Studio Mac', scopeKind: 'organization', pairingOwnerUserId: userId, status: 'offline' },
      { id: pendingId, organizationId, label: 'Never paired', scopeKind: 'organization', pairingOwnerUserId: userId },
    ] })

    await applyLifecycle(app, pairedId, 'revoke')
    const disconnected = await prisma.executor.findUniqueOrThrow({ where: { id: pairedId } })
    assert.equal(disconnected.status, 'revoked')
    assert.equal(disconnected.removedAt, null, 'disconnecting alone keeps the machine listed')
    assert.deepEqual((await listedIds(app)).sort(), [pairedId, pendingId].sort())

    await applyLifecycle(app, pairedId, 'remove')
    const removed = await prisma.executor.findUniqueOrThrow({ where: { id: pairedId } })
    assert.equal(removed.status, 'revoked')
    assert.ok(removed.removedAt, 'the row is kept for history and marked removed')
    assert.deepEqual(await listedIds(app), [pendingId])
    for (const url of [`/api/executors/${pairedId}`, `/api/executors/${pairedId}/access`]) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url)
    }
    const again = await app.inject({
      method: 'POST', url: '/api/executor-access-changes',
      payload: { executorId: pairedId, change: { kind: 'lifecycle', action: 'remove' } },
    })
    assert.equal(again.statusCode, 404, 'a deleted executor accepts no further change')

    // A pairing that never completed is deleted in one step, and is revoked
    // too, so its pairing code can no longer be confirmed.
    await applyLifecycle(app, pendingId, 'remove')
    const pending = await prisma.executor.findUniqueOrThrow({ where: { id: pendingId } })
    assert.equal(pending.status, 'revoked')
    assert.ok(pending.removedAt)
    assert.deepEqual(await listedIds(app), [])
  } finally {
    try {
      await app.close()
      await prisma.executor.deleteMany({ where: { organizationId } })
      await prisma.organizationMember.deleteMany({ where: { organizationId } })
      await prisma.user.deleteMany({ where: { id: userId } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
    } finally { await prisma.$disconnect() }
  }
})
