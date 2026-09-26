import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AGENT_REMINDER_PURPOSE, AuthorizedActionContextSchema } from '@nessie/schemas'
import { assertExecutorCommandBindingCurrent, bindChatExecutors, bindChatReminderExecutors } from '../src/index.js'
import { withChatMachines } from './chat-machine-fixture.js'
import { createRun, jobFor, postMessage, type LeaseWorld } from './lease-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const chatRun = async (world: LeaseWorld) => {
  const message = await postMessage(world, {})
  const run = await createRun(world, { triggerMessageId: message.id })
  assert.equal(await bindChatExecutors(world.prisma, {
    runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }),
  }), true)
  await world.prisma.run.update({ where: { id: run.id }, data: { status: 'completed' } })
  return run.id
}

const reminderRun = async (world: LeaseWorld, createdByRunId: string) => {
  const reminder = await world.prisma.agentReminder.create({ data: {
    agentId: world.agentId, threadId: world.threadId, createdByRunId,
    status: 'fired', dueAt: new Date(), firedAt: new Date(), note: 'zkontroluj to jeste jednou pls',
  } })
  const message = await postMessage(world, {
    role: 'system', userId: null, authorship: false, metadata: { agentReminder: { reminderId: reminder.id } },
  })
  const run = await createRun(world, { triggerMessageId: message.id })
  const actorContext = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'agent', actorId: world.agentId }, tenant: { organizationId: world.organizationId },
    actionContext: { requestId: randomUUID(), purpose: AGENT_REMINDER_PURPOSE },
  })
  return { runId: run.id, job: jobFor(world, {
    messageId: message.id, runId: run.id, interactive: false, actorContext,
  }) }
}

dbTest('a self-reminder and its next wake retain three chat machines without impersonating the person', async () => {
  await withChatMachines(async (world, machines) => {
    let source = await chatRun(world)
    for (let wake = 0; wake < 2; wake += 1) {
      const input = await reminderRun(world, source)
      assert.equal(await bindChatReminderExecutors(world.prisma, input), true)
      assert.equal(input.job.actorContext.actor.actorType, 'agent')
      assert.equal(input.job.actorContext.actionContext.effectiveUserId, undefined)
      const bindings = await world.prisma.executorBinding.findMany({ where: { runId: input.runId } })
      assert.equal(bindings.length, 6)
      assert.deepEqual(new Set(bindings.map((binding) => binding.executorId)), new Set(machines))
      assert.ok(bindings.every((binding) => !binding.leaseId && !binding.standingPolicyId))
      for (const binding of bindings) {
        const current = await world.prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, binding.id))
        assert.equal(current.owner.actorUserId, world.holderId)
      }
      assert.equal(await bindChatReminderExecutors(world.prisma, input), false, 'redelivery does not bind again')
      await world.prisma.run.update({ where: { id: input.runId }, data: { status: 'completed' } })
      source = input.runId
    }
  })
})

dbTest('a bound reminder cannot dispatch after its audience changes or its creating run is cancelled', async () => {
  await withChatMachines(async (world) => {
    const source = await chatRun(world)
    const input = await reminderRun(world, source)
    assert.equal(await bindChatReminderExecutors(world.prisma, input), true)
    const binding = await world.prisma.executorBinding.findFirstOrThrow({ where: { runId: input.runId } })
    const dispatch = () => world.prisma.$transaction((tx) => assertExecutorCommandBindingCurrent(tx, binding.id))
    await dispatch()
    await world.prisma.channelMember.create({ data: { channelId: world.channelId, userId: world.memberId } })
    await assert.rejects(dispatch, /no longer authorized/)
    await world.prisma.channelMember.deleteMany({ where: { channelId: world.channelId, userId: world.memberId } })
    await world.prisma.run.update({ where: { id: source }, data: { status: 'cancelled' } })
    await assert.rejects(dispatch, /no longer authorized/)
  })
})

dbTest('reminders recheck current access and cannot acquire machines absent from their source run', async () => {
  await withChatMachines(async (world, machines) => {
    await world.prisma.executor.update({ where: { id: machines[2] }, data: { status: 'offline' } })
    const source = await chatRun(world)
    await world.prisma.executor.update({ where: { id: machines[2] }, data: { status: 'online' } })
    await world.prisma.executorAgentOperationGrant.updateMany({
      where: { executorId: machines[1], agentId: world.agentId }, data: { state: 'denied' },
    })
    const input = await reminderRun(world, source)
    assert.equal(await bindChatReminderExecutors(world.prisma, input), true)
    const bindings = await world.prisma.executorBinding.findMany({ where: { runId: input.runId } })
    assert.deepEqual(new Set(bindings.map((binding) => binding.executorId)), new Set([machines[0]]))
  })
})

dbTest('cancelled, failed or still-running source work does not authorize a machine follow-up', async () => {
  await withChatMachines(async (world) => {
    const source = await chatRun(world)
    const input = await reminderRun(world, source)
    for (const status of ['cancelled', 'failed', 'running'] as const) {
      await world.prisma.run.update({ where: { id: source }, data: { status } })
      assert.equal(await bindChatReminderExecutors(world.prisma, input), false)
    }
    assert.equal(await world.prisma.executorBinding.count({ where: { runId: input.runId } }), 0)
  })
})

dbTest('reminder provenance, private audience and original human must all still match', async () => {
  await withChatMachines(async (world) => {
    const source = await chatRun(world)
    const input = await reminderRun(world, source)
    const refuse = async () => assert.equal(await bindChatReminderExecutors(world.prisma, input), false)
    await world.prisma.channelMember.create({ data: { channelId: world.channelId, userId: world.memberId } })
    await refuse()
    await world.prisma.channelMember.deleteMany({ where: { channelId: world.channelId, userId: world.holderId } })
    await refuse() // Another sole human cannot inherit the original person's machines.
    await world.prisma.channelMember.deleteMany({ where: { channelId: world.channelId } })
    await world.prisma.channelMember.create({ data: { channelId: world.channelId, userId: world.holderId } })
    await world.prisma.message.update({ where: { id: input.job.messageId }, data: { role: 'user' } })
    await refuse()
    await world.prisma.message.update({ where: { id: input.job.messageId }, data: { role: 'system' } })
    await world.prisma.agentReminder.updateMany({
      where: { createdByRunId: source }, data: { status: 'pending', firedAt: null },
    })
    await refuse()
    await world.prisma.agentReminder.updateMany({
      where: { createdByRunId: source }, data: { status: 'fired', firedAt: new Date() },
    })
    await world.prisma.executorAvailabilityCandidate.updateMany({ where: { runId: source }, data: { runId: null } })
    await refuse()
    assert.equal(await world.prisma.executorBinding.count({ where: { runId: input.runId } }), 0)
  })
})
