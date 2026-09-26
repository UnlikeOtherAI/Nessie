import assert from 'node:assert/strict'
import test from 'node:test'
import { bindChatExecutors } from '../src/index.js'
import { createRun, jobFor, postMessage } from './lease-fixture.js'
import { withChatMachines } from './chat-machine-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('ordinary private chat and its next message reach all three assigned machines without a lease', async () => {
  await withChatMachines(async (world, machines) => {
    for (const content of ['ukaz mi disky pls', 'now check free space again']) {
      const message = await postMessage(world, {})
      await world.prisma.message.update({ where: { id: message.id }, data: { content } })
      const run = await createRun(world, { triggerMessageId: message.id })
      const input = { runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }) }
      assert.equal(await bindChatExecutors(world.prisma, input), true)
      const bindings = await world.prisma.executorBinding.findMany({ where: { runId: run.id } })
      assert.equal(bindings.length, 6)
      assert.deepEqual(new Set(bindings.map((binding) => binding.executorId)), new Set(machines))
      assert.ok(bindings.every((binding) => binding.leaseId === null))
      assert.equal(await bindChatExecutors(world.prisma, input), false, 'redelivery preserves existing bindings')
    }
  })
})

dbTest('chat uses current assignment and machine availability', async () => {
  await withChatMachines(async (world, machines) => {
    await world.prisma.executorAgentOperationGrant.updateMany({
      where: { executorId: machines[1], agentId: world.agentId }, data: { state: 'denied' },
    })
    await world.prisma.executor.update({ where: { id: machines[2] }, data: { status: 'offline' } })
    const message = await postMessage(world, {})
    const run = await createRun(world, { triggerMessageId: message.id })
    assert.equal(await bindChatExecutors(world.prisma, {
      runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }),
    }), true)
    const bindings = await world.prisma.executorBinding.findMany({ where: { runId: run.id } })
    assert.deepEqual(new Set(bindings.map((binding) => binding.executorId)), new Set([machines[0]]))
  })
})

dbTest('unattended work, shared rooms and non-person messages do not gain chat machine access', async () => {
  await withChatMachines(async (world) => {
    const message = await postMessage(world, {})
    const run = await createRun(world, { triggerMessageId: message.id })
    const input = { runId: run.id, job: jobFor(world, { messageId: message.id, runId: run.id }) }
    assert.equal(await bindChatExecutors(world.prisma, {
      ...input, job: { ...input.job, interactive: false },
    }), false)
    await world.prisma.channel.update({ where: { id: world.channelId }, data: { type: 'standard' } })
    assert.equal(await bindChatExecutors(world.prisma, input), false)
    await world.prisma.channel.update({ where: { id: world.channelId }, data: { type: 'dm' } })
    await world.prisma.channelMember.create({ data: { channelId: world.channelId, userId: world.memberId } })
    assert.equal(await bindChatExecutors(world.prisma, input), false, 'another human makes this a shared room')
    await world.prisma.channelMember.deleteMany({
      where: { channelId: world.channelId, userId: world.memberId },
    })
    await world.prisma.message.update({ where: { id: message.id }, data: { metadata: {} } })
    assert.equal(await bindChatExecutors(world.prisma, input), false)
    assert.equal(await world.prisma.executorBinding.count({ where: { runId: run.id } }), 0)
  })
})
