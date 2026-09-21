import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { PrismaClient, type TaskSet } from '@prisma/client'
import { claimTaskSetItem } from './admission.js'
import { taskSetJournalStep } from './journal.js'
import { changeTaskSetHealth, TaskSetBlocked, TaskSetWait } from './state.js'
import { claimRunForExecution, RunFencedError, withRunExecutorFence } from '../run/execute/lifecycle.js'

const databaseTest = process.env.DATABASE_URL ? test : test.skip
const seed = async (t: TestContext) => {
  const prisma = new PrismaClient()
  const second = new PrismaClient()
  const organization = await prisma.organization.create({ data: { name: `task-set-test-${randomUUID()}` } })
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Fixture' } })
  const project = await prisma.project.create({ data: { name: 'Fixture', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Fixture', projectId: project.id } })
  const channel = await prisma.channel.create({ data: {
    organizationId: organization.id, projectId: project.id, teamId: team.id, label: 'Fixture', slug: randomUUID(),
  } })
  const agent = await prisma.agent.create({ data: { organizationId: organization.id, name: 'Fixture' } })
  const sets: string[] = []
  t.after(async () => {
    await prisma.queueJob.deleteMany({ where: { OR: sets.map((id) => ({ idempotencyKey: { startsWith: `task-set:${id}:` } })) } })
    await prisma.taskSet.deleteMany({ where: { id: { in: sets } } })
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.user.delete({ where: { id: user.id } })
    await Promise.all([prisma.$disconnect(), second.$disconnect()])
  })
  const create = async (options: Partial<Pick<TaskSet, 'capacityKey' | 'maxParallelRequests'>> = {}) => {
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    const set = await prisma.taskSet.create({ data: {
      organizationId: organization.id, ownerUserId: user.id, name: 'Fixture', objective: 'Enrich one item', instructions: 'Return JSON',
      executionAgentId: agent.id, executionThreadId: thread.id,
      processor: { provider: 'openai', model: 'fixture' }, capacityKey: randomUUID(), output: { kind: 'journal' },
      launchOrigin: {}, disclosure: { classified: true, basisScopes: [], disclosureSources: [] },
      status: 'running', inputClosedAt: new Date(), totalItems: 2, ...options,
    } })
    sets.push(set.id)
    const one = await prisma.taskSetItem.create({ data: {
      taskSetId: set.id, sequence: 1, clientKey: 'first', prompt: 'Summarize', input: { row: 1 }, disclosure: set.disclosure,
    } })
    await prisma.taskSetItem.create({ data: {
      taskSetId: set.id, sequence: 2, clientKey: 'second', prompt: 'Use prior result', input: { row: 2 },
      dependencies: [one.id], disclosure: set.disclosure,
    } })
    return set
  }
  return { prisma, second, create, user }
}

databaseTest('two workers claim one sequential item; provider receipts replay and stale commits are fenced', async (t) => {
  const { prisma, second, create } = await seed(t)
  const set = await create()
  const claims = await Promise.all([prisma, second].map((client) => claimTaskSetItem(client, set.id)))
  const claim = claims[0]
  assert.ok(claim && !('blocked' in claim))
  assert.equal(await prisma.taskSetAttempt.count({ where: { itemId: claim.item.id } }), 1)
  assert.equal(claim.item.sequence, 1)
  const execution = await withRunExecutorFence(claim.attempt.runId, () => claimRunForExecution(prisma, claim.attempt.runId))
  assert.ok(execution.claimed)
  assert.equal((await claimRunForExecution(second, claim.attempt.runId)).claimed, false)
  let calls = 0
  const step = { prisma, claim, fence: execution.token, sequence: 0, request: { row: 1 }, recoverable: true,
    execute: async () => { calls += 1; return { answer: '完成' } } }
  assert.deepEqual(await taskSetJournalStep(step), { answer: '完成' })
  assert.deepEqual(await taskSetJournalStep({ ...step, prisma: second }), { answer: '完成' })
  assert.equal(calls, 1)
  await assert.rejects(taskSetJournalStep({ ...step, request: { row: 2 } }), TaskSetBlocked)
  await prisma.run.update({ where: { id: claim.attempt.runId }, data: {
    executorHeartbeatAt: new Date(Date.now() - 180_000),
  } })
  const takeover = await claimRunForExecution(second, claim.attempt.runId)
  assert.ok(takeover.claimed)
  await assert.rejects(taskSetJournalStep({ ...step, sequence: 1 }), RunFencedError)
  await taskSetJournalStep({ ...step, prisma: second, fence: takeover.token })
  assert.equal(calls, 1)
})

databaseTest('three slots allow three sets, never a fourth; a missing dependency cannot jump the cursor', async (t) => {
  const { prisma, create } = await seed(t)
  const capacityKey = randomUUID()
  const sets = await Promise.all(Array.from({ length: 4 }, () => create({ capacityKey, maxParallelRequests: 3 })))
  const outcomes = await Promise.allSettled(sets.map((set) => claimTaskSetItem(prisma, set.id)))
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 3)
  const waiting = outcomes.find((result) => result.status === 'rejected')
  assert.ok(waiting?.status === 'rejected' && waiting.reason instanceof TaskSetWait)
  const independent = await create()
  await prisma.taskSet.update({ where: { id: independent.id }, data: { nextSequence: 2 } })
  assert.deepEqual(await claimTaskSetItem(prisma, independent.id), { blocked: 'blocked_dependency' })
  assert.equal(await prisma.taskSetAttempt.count({ where: { item: { taskSetId: independent.id } } }), 0)
  assert.equal((await prisma.taskSet.findUniqueOrThrow({ where: { id: independent.id } })).nextSequence, 2)
})

databaseTest('a hosted request with a lost outcome blocks recovery; a local durable receipt can recover', async (t) => {
  const { prisma, create } = await seed(t)
  const claim = await claimTaskSetItem(prisma, (await create()).id)
  assert.ok(claim && !('blocked' in claim))
  const execution = await claimRunForExecution(prisma, claim.attempt.runId)
  assert.ok(execution.claimed)
  const step = { prisma, claim, fence: execution.token, sequence: 0, request: 'stable', recoverable: false,
    execute: async () => { throw new Error('connection ended before the receipt') } }
  await assert.rejects(taskSetJournalStep(step))
  await assert.rejects(taskSetJournalStep({ ...step, execute: async () => 'must not dispatch' }),
    (error: unknown) => error instanceof TaskSetBlocked && error.reason === 'processor_outcome_unknown')
  assert.equal(await taskSetJournalStep({ ...step, recoverable: true, execute: async () => 'durable receipt' }), 'durable receipt')
})

databaseTest('offline alerts wait thirty uninterrupted minutes and pause never reactivates a set', async (t) => {
  const { prisma, create, user } = await seed(t)
  const set = await create()
  const now = new Date()
  await changeTaskSetHealth(prisma, set.id, { reason: 'processor_offline', waiting: true, offline: true, now })
  assert.equal(await prisma.userAlert.count({ where: { taskSetId: set.id } }), 0)
  const later = new Date(now.getTime() + 31 * 60_000)
  for (let n = 0; n < 2; n++) await changeTaskSetHealth(prisma, set.id, {
    reason: 'processor_offline', waiting: true, offline: true, now: later,
  })
  assert.equal(await prisma.userAlert.count({ where: { taskSetId: set.id, userId: user.id } }), 1)
  await prisma.taskSet.update({ where: { id: set.id }, data: { status: 'paused', offlineSince: null } })
  await changeTaskSetHealth(prisma, set.id, { reason: 'processor_failed' })
  assert.equal((await prisma.taskSet.findUniqueOrThrow({ where: { id: set.id } })).status, 'paused')
  assert.equal(await claimTaskSetItem(prisma, set.id), null)
})
