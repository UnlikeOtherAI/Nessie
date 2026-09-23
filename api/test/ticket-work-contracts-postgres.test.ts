import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Prisma, PrismaClient } from '@prisma/client'

/**
 * The ticket-work tables' CHECKs and partial unique indexes, against real rows
 * (20260923220000_ticket_work_contracts). Nothing writes these tables yet, so
 * this is the only proof that the database refuses what the later writers must
 * never store: an unknown status or reason, a terminal record without its end,
 * a second live record for one ticket, two tickets on one machine, two pending
 * reminders for one work record, and a policy that binds without having been
 * confirmed.
 *
 * Every row belongs to this seed and is removed with it; no global count is
 * asserted.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type World = Awaited<ReturnType<typeof seed>>

const seed = async (prisma: PrismaClient) => {
  const organizationId = randomUUID()
  const userId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `ticket work ${organizationId}` } })
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: 'Mover' } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: { label: 'c', slug: `c-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'CTO', organizationId } })
  const trigger = await prisma.agentTrigger.create({
    data: { agentId: agent.id, type: 'manual', targetChannelId: channel.id, targetThreadId: thread.id },
  })
  const [taskA, taskB] = await Promise.all([
    prisma.task.create({ data: { organizationId, projectId: project.id, title: 'A' } }),
    prisma.task.create({ data: { organizationId, projectId: project.id, title: 'B' } }),
  ])
  const executor = await prisma.executor.create({
    data: { organizationId, pairingOwnerUserId: userId, label: 'PC', scopeKind: 'private' },
  })
  const cleanup = async () => {
    await prisma.agentReminder.deleteMany({ where: { agentId: agent.id } })
    await prisma.agentTicketWork.deleteMany({ where: { organizationId } })
    await prisma.executorStandingPolicy.deleteMany({ where: { organizationId } })
    await prisma.executor.deleteMany({ where: { id: executor.id } })
    await prisma.task.deleteMany({ where: { organizationId } })
    await prisma.agentTrigger.deleteMany({ where: { id: trigger.id } })
    await prisma.agent.deleteMany({ where: { id: agent.id } })
    await prisma.thread.deleteMany({ where: { id: thread.id } })
    await prisma.channel.deleteMany({ where: { id: channel.id } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
  return {
    agentId: agent.id,
    cleanup,
    executorId: executor.id,
    organizationId,
    projectId: project.id,
    taskA: taskA.id,
    taskB: taskB.id,
    threadId: thread.id,
    triggerId: trigger.id,
    userId,
  }
}

const work = (world: World, data: Partial<Prisma.AgentTicketWorkUncheckedCreateInput> = {}) => ({
  agentId: world.agentId,
  organizationId: world.organizationId,
  projectId: world.projectId,
  startedByUserId: world.userId,
  status: 'active',
  taskId: world.taskA,
  threadId: world.threadId,
  triggerId: world.triggerId,
  ...data,
})

/** Rejects, and the refusal names the constraint or index that made it. */
const refused = async (write: Promise<unknown>, name: RegExp) => {
  await assert.rejects(write, (error: unknown) => {
    const text = error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error)
    assert.match(text, name)
    return true
  })
}

const UNIQUE = /P2002|unique constraint/i

const withWorld = (name: string, body: (prisma: PrismaClient, world: World) => Promise<void>) =>
  runDatabaseTest(name, async () => {
    const prisma = new PrismaClient()
    const world = await seed(prisma)
    try {
      await body(prisma, world)
    } finally {
      await world.cleanup()
      await prisma.$disconnect()
    }
  })

withWorld('a work record refuses an unknown status, state reason or wake reason', async (prisma, world) => {
  // An unknown status is neither live nor terminal, so the end CHECK refuses it
  // too; Postgres names whichever constraint it evaluated first.
  await refused(
    prisma.agentTicketWork.create({ data: work(world, { status: 'working' }) }),
    /agent_ticket_work_(status|ended)_known/,
  )
  await refused(
    prisma.agentTicketWork.create({ data: work(world, { stateReason: 'busy' }) }),
    /agent_ticket_work_state_reason_known/,
  )
  await refused(
    prisma.agentTicketWork.create({ data: work(world, { lastWakeReason: 'poke' }) }),
    /agent_ticket_work_last_wake_reason_known/,
  )
  await refused(prisma.agentTicketWork.create({ data: work(world, { wakeCount: -1 }) }), /agent_ticket_work_counters_valid/)
  const created = await prisma.agentTicketWork.create({
    data: work(world, { lastWakeReason: 'pickup', stateReason: 'machine_access_not_set_up' }),
  })
  assert.deepEqual(created.sessionIds, [])
  assert.equal(created.costUsd.toString(), '0')
})

withWorld('a terminal record carries its end, and a live one carries none', async (prisma, world) => {
  await refused(prisma.agentTicketWork.create({ data: work(world, { status: 'done' }) }), /agent_ticket_work_ended_known/)
  await refused(
    prisma.agentTicketWork.create({ data: work(world, { endedAt: new Date(), endedReason: 'left_flow' }) }),
    /agent_ticket_work_ended_known/,
  )
  await refused(
    prisma.agentTicketWork.create({
      data: work(world, { endedAt: new Date(), endedReason: 'shipped', status: 'done' }),
    }),
    /agent_ticket_work_ended_known/,
  )
  await prisma.agentTicketWork.create({
    data: work(world, { endedAt: new Date(), endedBy: world.userId, endedReason: 'merged', status: 'done' }),
  })
})

withWorld('one live record per trigger and ticket; an ended one does not count', async (prisma, world) => {
  const first = await prisma.agentTicketWork.create({ data: work(world, { status: 'parked' }) })
  await refused(prisma.agentTicketWork.create({ data: work(world, { status: 'queued' }) }), UNIQUE)
  // Another ticket under the same trigger is its own record.
  await prisma.agentTicketWork.create({ data: work(world, { status: 'queued', taskId: world.taskB }) })
  await prisma.agentTicketWork.update({
    where: { id: first.id },
    data: { endedAt: new Date(), endedReason: 'left_flow', status: 'cancelled' },
  })
  await prisma.agentTicketWork.create({ data: work(world, { status: 'waiting_machine' }) })
})

withWorld('one active ticket per machine; a parked or queued one keeps its machine', async (prisma, world) => {
  await prisma.agentTicketWork.create({ data: work(world, { executorId: world.executorId }) })
  await refused(
    prisma.agentTicketWork.create({ data: work(world, { executorId: world.executorId, taskId: world.taskB }) }),
    UNIQUE,
  )
  await prisma.agentTicketWork.create({
    data: work(world, { executorId: world.executorId, status: 'parked', taskId: world.taskB }),
  })
})

withWorld('one pending reminder per work record, each terminal status with its own field', async (prisma, world) => {
  const record = await prisma.agentTicketWork.create({ data: work(world) })
  const reminder = (data: Partial<Prisma.AgentReminderUncheckedCreateInput> = {}) => ({
    agentId: world.agentId,
    dueAt: new Date(Date.now() + 15 * 60_000),
    note: 'waiting for CI',
    threadId: world.threadId,
    workId: record.id,
    ...data,
  })
  await prisma.agentReminder.create({ data: reminder() })
  await refused(prisma.agentReminder.create({ data: reminder() }), UNIQUE)
  // Outside ticket work there is no per-record limit here: the caps are counts.
  await prisma.agentReminder.create({ data: reminder({ workId: null }) })
  await prisma.agentReminder.create({ data: reminder({ workId: null }) })
  await prisma.agentReminder.create({ data: reminder({ firedAt: new Date(), status: 'fired' }) })
  await prisma.agentReminder.create({ data: reminder({ cancelledReason: 'replaced', status: 'cancelled' }) })
  await refused(prisma.agentReminder.create({ data: reminder({ status: 'fired' }) }), /agent_reminders_status_known/)
  await refused(prisma.agentReminder.create({ data: reminder({ status: 'cancelled' }) }), /agent_reminders_status_known/)
  await refused(
    prisma.agentReminder.create({ data: reminder({ cancelledReason: 'bored', status: 'cancelled' }) }),
    /agent_reminders_status_known/,
  )
  await refused(prisma.agentReminder.create({ data: reminder({ status: 'snoozed' }) }), /agent_reminders_status_known/)
})

withWorld('a standing policy binds only once confirmed, and names why it stopped', async (prisma, world) => {
  const policy = (data: Partial<Prisma.ExecutorStandingPolicyUncheckedCreateInput> = {}) => ({
    agentId: world.agentId,
    authorUserId: world.userId,
    hostProfile: { allowedRootNames: ['nessie'], maxBudgetUsd: 5, permissionMode: 'default' },
    organizationId: world.organizationId,
    triggerDigest: `sha256:${'a'.repeat(64)}`,
    triggerId: world.triggerId,
    ...data,
  })
  const origin = { organizationId: world.organizationId, teamId: randomUUID(), userId: world.userId }
  const preparing = await prisma.executorStandingPolicy.create({ data: policy() })
  assert.equal(preparing.status, 'preparing')
  await refused(
    prisma.executorStandingPolicy.create({ data: policy({ status: 'live' }) }),
    /executor_standing_policies_confirmed_known/,
  )
  await refused(
    prisma.executorStandingPolicy.create({ data: policy({ confirmedAt: new Date() }) }),
    /executor_standing_policies_confirmed_known/,
  )
  const live = await prisma.executorStandingPolicy.create({
    data: policy({ authorOrigin: origin, confirmedAt: new Date(), status: 'live' }),
  })
  await refused(
    prisma.executorStandingPolicy.update({ where: { id: live.id }, data: { status: 'suspended' } }),
    /executor_standing_policies_suspended_reason_known/,
  )
  await prisma.executorStandingPolicy.update({
    where: { id: live.id },
    data: { status: 'suspended', suspendedReason: 'trigger_changed' },
  })
  await refused(
    prisma.executorStandingPolicy.update({
      where: { id: live.id },
      data: { endedAt: new Date(), endedReason: 'bored', status: 'ended', suspendedReason: null },
    }),
    /executor_standing_policies_ended_reason_known/,
  )
  await prisma.executorStandingPolicy.update({
    where: { id: live.id },
    data: { endedAt: new Date(), endedByUserId: world.userId, endedReason: 'person', status: 'ended', suspendedReason: null },
  })
  await refused(prisma.executorStandingPolicy.create({ data: policy({ status: 'paused' }) }), /executor_standing_policies_status_known/)

  // The pool: one or two machines, each position once.
  const pool = (position: number) => ({
    descriptorConfigDigest: `sha256:${'b'.repeat(64)}`,
    executorId: world.executorId,
    localPolicyDigest: `sha256:${'c'.repeat(64)}`,
    policyId: preparing.id,
    position,
  })
  await refused(
    prisma.executorStandingPolicyExecutor.create({ data: pool(2) }),
    /executor_standing_policy_executors_position_known/,
  )
  await prisma.executorStandingPolicyExecutor.create({ data: pool(0) })
  await refused(prisma.executorStandingPolicyExecutor.create({ data: pool(1) }), UNIQUE)

  // The work record points at its policy, which outlives nothing it names.
  const record = await prisma.agentTicketWork.create({ data: work(world, { policyId: preparing.id }) })
  await prisma.executorStandingPolicy.delete({ where: { id: preparing.id } })
  const after = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: record.id } })
  assert.equal(after.policyId, null, 'a deleted policy leaves the record, unpinned')
})

withWorld('a deleted trigger leaves its work and policy behind, unlinked', async (prisma, world) => {
  const record = await prisma.agentTicketWork.create({ data: work(world) })
  const policy = await prisma.executorStandingPolicy.create({
    data: {
      agentId: world.agentId,
      authorUserId: world.userId,
      hostProfile: {},
      organizationId: world.organizationId,
      triggerDigest: 'sha256:0',
      triggerId: world.triggerId,
    },
  })
  await prisma.agentTrigger.delete({ where: { id: world.triggerId } })
  assert.equal((await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: record.id } })).triggerId, null)
  assert.equal((await prisma.executorStandingPolicy.findUniqueOrThrow({ where: { id: policy.id } })).triggerId, null)
})
