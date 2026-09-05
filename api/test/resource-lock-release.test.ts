import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  acquireResourceLock,
  releaseResourceLock,
} from '../src/services/resource-locks.js'

/**
 * Who may drop a lock, and what a second release does.
 *
 * `releaseResourceLock` scoped only by `(id, organizationId)`, so any member of
 * the organisation could release any agent's lock, and it did not guard on
 * `releasedAt: null`, so a re-release silently overwrote the release time —
 * misreporting how long the resource was actually held.
 *
 * DB-backed because the acquire path is `pg_advisory_xact_lock` plus a
 * conflicting-lock check inside a real transaction: whether a released lock
 * stops blocking the next acquirer is a property of the rows, not of a fake.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  organizationId: string
  otherAgentId: string
  resourcePath: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `resource-lock ${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `project ${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `team ${suffix}`, projectId: project.id },
  })
  const makeAgent = (name: string) => prisma.agent.create({
    data: {
      name,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const agent = await makeAgent(`Holder ${suffix}`)
  const otherAgent = await makeAgent(`Bystander ${suffix}`)

  return {
    agentId: agent.id,
    organizationId: organization.id,
    otherAgentId: otherAgent.id,
    resourcePath: `/workspace/${suffix}.ts`,
  }
}

const withSeed = async (
  body: (prisma: PrismaClient, sown: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const sown = await seed(prisma)
  try {
    await body(prisma, sown)
  } finally {
    await prisma.organization.deleteMany({ where: { id: sown.organizationId } })
    await prisma.$disconnect()
  }
}

const acquire = (prisma: PrismaClient, sown: Seed, agentId: string) =>
  acquireResourceLock(prisma, sown.organizationId, {
    agentId,
    resourcePath: sown.resourcePath,
  })

runDatabaseTest('the holder releases its own lock exactly once', async () => {
  await withSeed(async (prisma, sown) => {
    const lock = await acquire(prisma, sown, sown.agentId)
    assert.ok(lock)

    const released = await releaseResourceLock(prisma, sown.organizationId, {
      agentId: sown.agentId,
      lockId: lock.id,
    })
    assert.ok(released?.releasedAt)

    // A second release is a refusal, not a silent overwrite of the first
    // release time — which is the number that says how long it was held.
    const again = await releaseResourceLock(prisma, sown.organizationId, {
      agentId: sown.agentId,
      lockId: lock.id,
    })
    assert.equal(again, null)
    const row = await prisma.resourceLock.findUniqueOrThrow({
      where: { id: lock.id },
    })
    assert.equal(row.releasedAt?.toISOString(), released.releasedAt)
  })
})

runDatabaseTest('another agent in the same organisation cannot release it', async () => {
  await withSeed(async (prisma, sown) => {
    const lock = await acquire(prisma, sown, sown.agentId)
    assert.ok(lock)

    assert.equal(
      await releaseResourceLock(prisma, sown.organizationId, {
        agentId: sown.otherAgentId,
        lockId: lock.id,
      }),
      null,
    )
    // Still held: the resource is genuinely still locked against the bystander.
    assert.equal(await acquire(prisma, sown, sown.otherAgentId), null)

    // And once the holder does release it, the bystander can take it.
    assert.ok(await releaseResourceLock(prisma, sown.organizationId, {
      agentId: sown.agentId,
      lockId: lock.id,
    }))
    assert.ok(await acquire(prisma, sown, sown.otherAgentId))
  })
})
