import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { listAgentTriggerActivity } from '../src/services/trigger-activity.js'

// Integration test against the local Postgres (see AGENTS.md). "Is this trigger
// executing?" is answered from real `runs` rows joined to their trigger, and
// two of the properties that matter cannot be shown with a fake: that a second
// concurrent execution appears as a second row rather than overwriting the
// first (the run/delivery relation is what keeps them distinct), and that
// `DISTINCT ON` returns the newest finished run *per trigger* rather than the
// newest few runs overall.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  threadId: string
  triggerIds: { busy: string; quiet: string }
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const org = await prisma.organization.create({ data: { name: `trigger-activity ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project ${suffix}`, organizationId: org.id },
  })
  const team = await prisma.team.create({
    data: { name: `team ${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `channel ${suffix}`,
      organizationId: org.id,
      projectId: project.id,
      slug: `c-${suffix.slice(0, 8)}`,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: `Agent ${suffix}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const busy = await prisma.agentTrigger.create({
    data: { agentId: agent.id, config: {}, name: 'busy', type: 'interval' },
  })
  const quiet = await prisma.agentTrigger.create({
    data: { agentId: agent.id, config: {}, name: 'quiet', type: 'scheduled' },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    threadId: thread.id,
    triggerIds: { busy: busy.id, quiet: quiet.id },
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.run.deleteMany({ where: { agentId: s.agentId } })
  await prisma.agentTriggerDelivery.deleteMany({
    where: { triggerId: { in: [s.triggerIds.busy, s.triggerIds.quiet] } },
  })
  await prisma.agentTrigger.deleteMany({ where: { agentId: s.agentId } })
  await prisma.agent.deleteMany({ where: { id: s.agentId } })
  await prisma.thread.deleteMany({ where: { id: s.threadId } })
  await prisma.channel.deleteMany({ where: { id: s.channelId } })
  await prisma.team.deleteMany({ where: { id: s.teamId } })
  await prisma.project.deleteMany({ where: { id: s.projectId } })
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
}

const addRun = async (
  prisma: PrismaClient,
  s: Seed,
  input: {
    createdAt: Date
    finishedAt?: Date
    status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed'
    triggerId: string
  },
): Promise<string> => {
  const delivery = await prisma.agentTriggerDelivery.create({
    data: { dedupeKey: randomUUID(), status: 'delivered', triggerId: input.triggerId },
  })
  const run = await prisma.run.create({
    data: {
      agentId: s.agentId,
      createdAt: input.createdAt,
      finishedAt: input.finishedAt ?? null,
      status: input.status,
      threadId: s.threadId,
      triggerDeliveryId: delivery.id,
      triggerId: input.triggerId,
    },
  })
  return run.id
}

runDatabaseTest('two concurrent executions of one trigger are two rows, not a flag', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const first = await addRun(prisma, s, {
      createdAt: new Date(Date.now() - 60_000),
      status: 'running',
      triggerId: s.triggerIds.busy,
    })
    const second = await addRun(prisma, s, {
      createdAt: new Date(Date.now() - 30_000),
      status: 'pending',
      triggerId: s.triggerIds.busy,
    })

    const activity = await listAgentTriggerActivity(prisma, s.agentId)
    const busy = activity.find((entry) => entry.triggerId === s.triggerIds.busy)

    assert.equal(busy?.running.length, 2)
    assert.deepEqual(busy?.running.map((run) => run.runId), [first, second])
    // Each execution carries its own delivery, so the two are distinguishable
    // without guessing from timestamps.
    assert.equal(new Set(busy?.running.map((run) => run.deliveryId)).size, 2)
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a run parked on an approval still counts as executing', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    await addRun(prisma, s, {
      createdAt: new Date(),
      status: 'waiting_approval',
      triggerId: s.triggerIds.busy,
    })

    const activity = await listAgentTriggerActivity(prisma, s.agentId)
    assert.equal(
      activity.find((entry) => entry.triggerId === s.triggerIds.busy)?.running.length,
      1,
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the last outcome is per trigger, not the newest run overall', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // The quiet trigger failed a while ago and has said nothing since. The busy
    // one has run repeatedly and succeeded most recently. Reading "the newest
    // few runs" would report the quiet trigger as having no outcome at all.
    await addRun(prisma, s, {
      createdAt: new Date(Date.now() - 600_000),
      finishedAt: new Date(Date.now() - 590_000),
      status: 'failed',
      triggerId: s.triggerIds.quiet,
    })
    for (let index = 0; index < 5; index += 1) {
      await addRun(prisma, s, {
        createdAt: new Date(Date.now() - 300_000 + index * 1_000),
        finishedAt: new Date(Date.now() - 290_000 + index * 1_000),
        status: 'completed',
        triggerId: s.triggerIds.busy,
      })
    }

    const activity = await listAgentTriggerActivity(prisma, s.agentId)
    assert.equal(
      activity.find((entry) => entry.triggerId === s.triggerIds.quiet)?.lastOutcome,
      'failed',
    )
    assert.equal(
      activity.find((entry) => entry.triggerId === s.triggerIds.busy)?.lastOutcome,
      'completed',
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a trigger that has never run reports no outcome rather than success', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    const activity = await listAgentTriggerActivity(prisma, s.agentId)
    assert.equal(activity.length, 2)
    assert.deepEqual(
      activity.map((entry) => entry.lastOutcome),
      [null, null],
    )
  } finally {
    await cleanup(prisma, s)
    await prisma.$disconnect()
  }
})
