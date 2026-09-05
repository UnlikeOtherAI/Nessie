import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  deleteAgentTrigger,
  getAgentTrigger,
  listAgentTriggerDeliveries,
  pauseAgentTrigger,
  resumeAgentTrigger,
  updateAgentTrigger,
} from '../src/services/trigger-crud.js'

/**
 * Tenancy is in the `where`, not only in the route.
 *
 * `AgentTrigger` has no `organizationId` column: it reaches a tenant only
 * through its agent or its workflow installation. Every by-id function here
 * used to issue a bare `findUnique({ where: { id } })` / `deleteMany({ where:
 * { id } })`, so the authorisation predicate (the route's
 * `isTriggerAccessibleToActor`) and the mutation predicate were two different
 * queries — and any second caller inherited nothing.
 *
 * This is DB-backed because the thing under test IS the join: a Prisma fake
 * returning a row for an id would answer identically before and after the fix.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  foreignOrganizationId: string
  organizationId: string
  triggerId: string
  withDeliveriesId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `trigger-scope ${suffix}` },
  })
  const foreign = await prisma.organization.create({
    data: { name: `trigger-scope-foreign ${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `project ${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `team ${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `channel ${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `c-${suffix.slice(0, 8)}`,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `Agent ${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: {},
      name: 'armed',
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'webhook',
    },
  })
  const withDeliveries = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: {},
      name: 'delivered',
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'webhook',
    },
  })
  await prisma.agentTriggerDelivery.create({
    data: {
      dedupeKey: `dedupe-${suffix}`,
      payload: {},
      source: 'manual',
      triggerId: withDeliveries.id,
    },
  })

  return {
    foreignOrganizationId: foreign.id,
    organizationId: organization.id,
    triggerId: trigger.id,
    withDeliveriesId: withDeliveries.id,
  }
}

const cleanup = async (prisma: PrismaClient, sown: Seed): Promise<void> => {
  await prisma.organization.deleteMany({
    where: { id: { in: [sown.organizationId, sown.foreignOrganizationId] } },
  })
}

const withSeed = async (
  body: (prisma: PrismaClient, sown: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const sown = await seed(prisma)
  try {
    await body(prisma, sown)
  } finally {
    await cleanup(prisma, sown)
    await prisma.$disconnect()
  }
}

runDatabaseTest('a by-id read is scoped to the organisation', async () => {
  await withSeed(async (prisma, sown) => {
    assert.notEqual(
      await getAgentTrigger(prisma, {
        organizationId: sown.organizationId,
        triggerId: sown.triggerId,
      }),
      null,
    )
    assert.equal(
      await getAgentTrigger(prisma, {
        organizationId: sown.foreignOrganizationId,
        triggerId: sown.triggerId,
      }),
      null,
    )
  })
})

runDatabaseTest('a foreign organisation cannot update a trigger', async () => {
  await withSeed(async (prisma, sown) => {
    assert.equal(
      await updateAgentTrigger(
        prisma,
        { organizationId: sown.foreignOrganizationId, triggerId: sown.triggerId },
        { name: 'stolen' },
      ),
      null,
    )
    const untouched = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: sown.triggerId },
    })
    assert.equal(untouched.name, 'armed')

    const updated = await updateAgentTrigger(
      prisma,
      { organizationId: sown.organizationId, triggerId: sown.triggerId },
      { name: 'renamed' },
    )
    assert.equal(updated?.name, 'renamed')
  })
})

runDatabaseTest('a foreign organisation cannot pause, resume or delete', async () => {
  await withSeed(async (prisma, sown) => {
    const foreign = {
      organizationId: sown.foreignOrganizationId,
      triggerId: sown.triggerId,
    }
    assert.equal(await pauseAgentTrigger(prisma, foreign), null)
    assert.equal(await resumeAgentTrigger(prisma, foreign), null)
    assert.equal(await deleteAgentTrigger(prisma, foreign), false)
    assert.equal(
      await prisma.agentTrigger.count({ where: { id: sown.triggerId } }),
      1,
    )

    const own = {
      organizationId: sown.organizationId,
      triggerId: sown.triggerId,
    }
    assert.equal((await pauseAgentTrigger(prisma, own))?.status, 'paused')
    assert.equal((await resumeAgentTrigger(prisma, own))?.status, 'active')
    assert.equal(await deleteAgentTrigger(prisma, own), true)
  })
})

runDatabaseTest('delivery history is read through the same scope', async () => {
  await withSeed(async (prisma, sown) => {
    assert.equal(
      (await listAgentTriggerDeliveries(
        prisma,
        { organizationId: sown.organizationId, triggerId: sown.withDeliveriesId },
        10,
      )).length,
      1,
    )
    assert.deepEqual(
      await listAgentTriggerDeliveries(
        prisma,
        {
          organizationId: sown.foreignOrganizationId,
          triggerId: sown.withDeliveriesId,
        },
        10,
      ),
      [],
    )
  })
})
