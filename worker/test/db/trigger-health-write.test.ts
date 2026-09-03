import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { recordTriggerHealthFailure } from '../../src/control/trigger-health.js'
import { TriggerLaunchOriginError } from '../../src/control/trigger-origin.js'
import { AgentTodoScheduledConfigError } from '@nessie/team-admin'

// The health write decides whether a failure is NEW — which is what makes the
// alert fire exactly once per transition rather than once per sweep.
//
// It cannot assume an exclusive claim: the scheduler sweep and the retry poller
// both hold one, but `dispatchEventTriggers` fans out with no claim at all, so
// two events can fail the same trigger at the same instant. The decision
// therefore lives in the statement's WHERE clause rather than in a read
// followed by a write.
//
// In `test/db/` because it drives that global contention directly.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = { organizationId: string; triggerId: string }

const seedActiveTrigger = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `health ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: { interval_minutes: 15 },
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'interval',
    },
  })
  return { organizationId: org.id, triggerId: trigger.id }
}

const identityFailure = (): TriggerLaunchOriginError =>
  new TriggerLaunchOriginError(
    'uoa_identity_unverifiable',
    'its saved UnlikeOtherAI identity is missing or no longer valid',
  )

runDatabaseTest('one failure is one transition, however many workers report it', async () => {
  const prisma = new PrismaClient()
  const seed = await seedActiveTrigger(prisma)

  try {
    // Four unclaimed reporters racing, as concurrent event fires would.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        recordTriggerHealthFailure(prisma, {
          error: identityFailure(),
          triggerId: seed.triggerId,
        })),
    )

    const transitions = results.filter((result) => result !== null)
    assert.equal(
      transitions.length,
      1,
      'exactly one reporter may claim the transition, or the alert double-fires',
    )

    const row = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { healthReason: true, healthRevision: true, status: true },
    })
    assert.equal(row.status, 'needs_reauthorization')
    assert.equal(row.healthReason, 'uoa_identity_unverifiable')
    assert.equal(row.healthRevision, 1, 'the revision advances once, not once per reporter')
    assert.equal(transitions[0]?.healthRevision, 1)
  } finally {
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('a schedule stuck in the same failure never re-notifies', async () => {
  const prisma = new PrismaClient()
  const seed = await seedActiveTrigger(prisma)

  try {
    const first = await recordTriggerHealthFailure(prisma, {
      error: identityFailure(),
      triggerId: seed.triggerId,
    })
    assert.notEqual(first, null, 'the first failure is a transition')

    // Ninety-six sweeps a day must not become ninety-six alerts.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const repeat = await recordTriggerHealthFailure(prisma, {
        error: identityFailure(),
        triggerId: seed.triggerId,
      })
      assert.equal(repeat, null, 'the same failure repeating is not a new transition')
    }

    const row = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { healthRevision: true },
    })
    assert.equal(row.healthRevision, 1)
  } finally {
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('a vanished scheduled to-do template is an error with one durable alert', async () => {
  const prisma = new PrismaClient()
  const seed = await seedActiveTrigger(prisma)

  try {
    const missingTemplate = randomUUID()
    const first = await recordTriggerHealthFailure(prisma, {
      error: new AgentTodoScheduledConfigError(missingTemplate, seed.triggerId),
      triggerId: seed.triggerId,
    })
    const second = await recordTriggerHealthFailure(prisma, {
      error: new AgentTodoScheduledConfigError(missingTemplate, seed.triggerId),
      triggerId: seed.triggerId,
    })
    assert.equal(first?.status, 'error')
    assert.equal(second, null, 'the same broken config must not re-alert every sweep')
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({
      select: { healthReason: true, healthRevision: true, status: true },
      where: { id: seed.triggerId },
    })
    assert.equal(trigger.status, 'error')
    assert.equal(trigger.healthReason, 'todo_template_invalid')
    assert.equal(trigger.healthRevision, 1)
  } finally {
    await prisma.$executeRawUnsafe(
      'DELETE FROM queue_jobs WHERE idempotency_key LIKE $1',
      `trigger-health:${seed.triggerId}:%`,
    )
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('a different failure after a repair is a fresh transition', async () => {
  const prisma = new PrismaClient()
  const seed = await seedActiveTrigger(prisma)

  try {
    await recordTriggerHealthFailure(prisma, {
      error: identityFailure(),
      triggerId: seed.triggerId,
    })

    // A different cause on the same trigger must be told, not swallowed.
    const second = await recordTriggerHealthFailure(prisma, {
      error: new TriggerLaunchOriginError(
        'channel_access_lost',
        'its saved user no longer has access to the target channel',
      ),
      triggerId: seed.triggerId,
    })
    assert.notEqual(second, null)
    assert.equal(second?.healthRevision, 2)
    assert.equal(second?.status, 'error', 'a lost channel is not repaired by reauthorizing')
  } finally {
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('the alert job commits with the transition, not after it', async () => {
  const prisma = new PrismaClient()
  const seed = await seedActiveTrigger(prisma)

  try {
    const transition = await recordTriggerHealthFailure(prisma, {
      error: identityFailure(),
      triggerId: seed.triggerId,
    })
    assert.notEqual(transition, null)

    // Writing health first and enqueuing afterwards left a window that
    // recreated the failure this whole change exists to kill: once the health
    // update commits the schedule is never swept again, and the guard makes the
    // next identical failure a no-op — so a crash in between lost the only
    // alert, permanently. The job must therefore be durable the moment the
    // transition is.
    const job = await prisma.queueJob.findFirst({
      where: {
        idempotencyKey: `trigger-health:${seed.triggerId}:${transition?.healthRevision}`,
        topic: 'trigger.health-alert',
      },
      select: { payload: true },
    })
    assert.notEqual(job, null, 'the transition must not be visible without its alert')

    const payload = job?.payload as Record<string, unknown> | undefined
    assert.equal(payload?.['triggerId'], seed.triggerId)
    assert.equal(payload?.['status'], 'needs_reauthorization')
    assert.equal(payload?.['healthRevision'], transition?.healthRevision)
  } finally {
    await prisma.$executeRawUnsafe(
      'DELETE FROM queue_jobs WHERE idempotency_key LIKE $1',
      `trigger-health:${seed.triggerId}:%`,
    )
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})
