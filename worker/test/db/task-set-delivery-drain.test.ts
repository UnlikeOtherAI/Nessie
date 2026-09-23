import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { AuthorizedActionContextSchema, TASK_SET_DELIVERY_PURPOSE } from '@nessie/schemas'

import { resolveReplyRootMessageId } from '../../src/run/execute/reply-placement.js'
import { claimThreadRunOrPend, drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
import { finalizeTaskSet } from '../../src/task-sets/finalize.js'
import { taskSetFinalizationFixture } from '../../src/task-sets/finalization-fixture.js'
import { dispatchSeededMail } from './mailbox-serialization-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

// A task-set delivery that reaches a busy receiver pends like any other
// message, but it must not be folded into a batch: only the latest row of a
// batch drives the run, and a hidden `system` kickoff never reaches the model
// as history. Batched, a delivery would lose its result notice and run under
// whoever spoke last. Each one drains alone instead.
//
// The deliveries come through the production path — `finalizeTaskSet` writes
// the mailbox row and `dispatchNextMailboxMessage` pends it — so the stored
// actor context is the one real delivery writes, not a hand-built copy.

type QueuedRunPayload = {
  actorContext: {
    actor: { actorId: string; actorType: string }
    actionContext: { correlationId?: string; effectiveUserId?: string; purpose?: string }
  }
  batchMessageIds: string[]
  interactive?: boolean
  messageId: string
}

runDatabaseTest('a busy receiver runs two task-set deliveries and a message between them as three runs, in order', async (t) => {
  const f = await taskSetFinalizationFixture(t)
  const { prisma } = f
  await assertGlobalQueuesQuiet(prisma)

  // Alice owns the fixture's set, Carol owns a second set with the same
  // receiver, and Bob speaks in the receiver's conversation between the two.
  const [bob, carol] = await Promise.all(['Bob', 'Carol'].map((displayName) => prisma.user.create({
    data: { displayName, email: `${randomUUID()}@task-set-drain.test` },
  })))
  // Runs after the fixture's own cleanup, which has removed the organisation
  // and disconnected; the delete reconnects, so disconnect again.
  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [bob!.id, carol!.id] } } })
    await prisma.$disconnect()
  })
  await prisma.organizationMember.createMany({ data: [bob!, carol!].map((user) => ({
    organizationId: f.org.id, role: 'member' as const, userId: user.id,
  })) })
  await prisma.channelMember.createMany({ data: [bob!, carol!].map((user) => ({
    channelId: f.channel.id, userId: user.id,
  })) })

  // With three members the conversation no longer implies one owner's user
  // scope, so both sets are classified to the conversation itself.
  const disclosure = { classified: true as const,
    basisScopes: [{ scopeType: 'channel', scopeId: f.channel.id }], disclosureSources: [] }
  const receiver = { agentId: f.receiver.id, channelId: f.channel.id, instructions: 'Summarise the results.' }
  await prisma.taskSet.update({ where: { id: f.set.id }, data: { disclosure, receiver, deliveryStatus: 'pending' } })
  await prisma.taskSetItem.updateMany({ where: { taskSetId: f.set.id }, data: {
    disclosure, resultDisclosure: disclosure,
  } })
  const carolSet = await prisma.taskSet.create({ data: {
    organizationId: f.org.id, ownerUserId: carol!.id, executionAgentId: f.agent.id, executionThreadId: f.thread.id,
    name: 'Carol results', objective: 'Summarize every item', instructions: '',
    processor: { provider: 'test', model: 'test' }, capacityKey: randomUUID(), output: { kind: 'journal' },
    launchOrigin: { ...f.origin, actor: { actorType: 'user', actorId: carol!.id },
      actionContext: { requestId: randomUUID(), effectiveUserId: carol!.id } },
    disclosure, receiver, deliveryStatus: 'pending',
    status: 'running', inputClosedAt: new Date(), totalItems: 1, completedItems: 1, nextSequence: 2,
    items: { create: { sequence: 1, clientKey: '1', prompt: '', input: { id: 1 }, disclosure,
      resultDisclosure: disclosure, result: 'Carol result', status: 'completed' } },
  } })

  // The receiver is mid-run, so everything below pends.
  const busy = await prisma.run.create({ data: { agentId: f.receiver.id, threadId: f.thread.id, status: 'running' } })
  const lastPending = () => prisma.runThreadPendingMessage.findFirstOrThrow({
    where: { agentId: f.receiver.id, threadId: f.thread.id }, orderBy: { seq: 'desc' },
  })
  const deliver = async (setId: string) => {
    await finalizeTaskSet(f.deps, setId)
    const mail = await prisma.agentMailboxMessage.findFirstOrThrow({ where: { taskSetId: setId } })
    await prisma.agentMailboxMessage.update({ where: { id: mail.id }, data: { visibleAt: new Date(0) } })
    await dispatchSeededMail(prisma, mail)
    return lastPending()
  }

  const alicePending = await deliver(f.set.id)
  const bobMessage = await prisma.message.create({ data: {
    threadId: f.thread.id, role: 'user', userId: bob!.id, content: 'Are the numbers in yet?',
  } })
  // Bob's turn pends exactly as the orchestrator's reply claim records it.
  const bobContext = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: bob!.id, roles: ['member'] },
    tenant: f.origin.tenant,
    actionContext: { requestId: randomUUID() },
  })
  assert.equal(await prisma.$transaction((tx) => claimThreadRunOrPend(tx, {
    agentId: f.receiver.id, threadId: f.thread.id,
    pending: { actorContext: bobContext, channelId: f.channel.id, interactive: true, messageId: bobMessage.id },
  })), 'pended')
  const carolPending = await deliver(carolSet.id)
  assert.equal(await prisma.run.count({ where: { agentId: f.receiver.id, threadId: f.thread.id } }), 1)

  // `messages.created_at` is `timestamp(3)`; state the arrival order rather
  // than race the clock for it.
  const arrival = [alicePending.messageId, bobMessage.id, carolPending.messageId]
  const base = Date.now()
  for (const [index, id] of arrival.entries()) {
    await prisma.message.update({ where: { id }, data: { createdAt: new Date(base + index * 1_000) } })
  }

  const expected = [
    { messageId: alicePending.messageId, actorId: f.user.id, effectiveUserId: f.user.id,
      purpose: TASK_SET_DELIVERY_PURPOSE, correlationId: `task-set:${f.set.id}`, interactive: false,
      notice: `Task set ${f.set.id} has finished processing.`, replyRoot: undefined },
    { messageId: bobMessage.id, actorId: bob!.id, effectiveUserId: undefined,
      purpose: undefined, correlationId: undefined, interactive: true,
      notice: 'Are the numbers in yet?', replyRoot: bobMessage.id },
    { messageId: carolPending.messageId, actorId: carol!.id, effectiveUserId: carol!.id,
      purpose: TASK_SET_DELIVERY_PURPOSE, correlationId: `task-set:${carolSet.id}`, interactive: false,
      notice: `Task set ${carolSet.id} has finished processing.`, replyRoot: undefined },
  ]
  let predecessorId = busy.id
  for (const turn of expected) {
    await prisma.run.update({ where: { id: predecessorId }, data: { status: 'completed', finishedAt: new Date() } })
    const runId = await drainPendingThreadMessages(prisma, { agentId: f.receiver.id, threadId: f.thread.id })
    assert.ok(runId, 'each terminal drain starts exactly one follow-up')

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: {
      principalUserId: true, replyPlacement: true, triggerMessageId: true,
    } })
    assert.equal(run.triggerMessageId, turn.messageId)
    assert.equal(run.principalUserId, null)
    const trigger = await prisma.message.findUniqueOrThrow({ where: { id: turn.messageId }, select: {
      content: true, id: true, rootMessageId: true,
    } })
    assert.ok(trigger.content.includes(turn.notice), 'the run is driven by its own row, never a later one')
    // A hidden kickoff cannot own a reply thread, so a delivery answers in the
    // conversation; Bob's turn is answered under his own message.
    assert.equal(resolveReplyRootMessageId(trigger, null, run.replyPlacement), turn.replyRoot)

    const job = await prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey: `run:batch:${runId}` } })
    const payload = job.payload as QueuedRunPayload
    assert.equal(payload.messageId, turn.messageId)
    assert.deepEqual(payload.batchMessageIds, [turn.messageId], 'nothing else is folded into this run')
    assert.equal(payload.interactive, turn.interactive)
    assert.equal(payload.actorContext.actor.actorType, 'user')
    assert.equal(payload.actorContext.actor.actorId, turn.actorId)
    assert.equal(payload.actorContext.actionContext.effectiveUserId, turn.effectiveUserId)
    assert.equal(payload.actorContext.actionContext.purpose, turn.purpose)
    assert.equal(payload.actorContext.actionContext.correlationId, turn.correlationId)
    predecessorId = runId
  }

  assert.equal(await prisma.runThreadPendingMessage.count({
    where: { agentId: f.receiver.id, threadId: f.thread.id },
  }), 0)
})
