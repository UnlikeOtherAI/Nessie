import assert from 'node:assert/strict'
import { finalizeTaskSet } from '../../src/task-sets/finalize.js'
import { dispatchNextMailboxMessage } from '../../src/control/mailbox.js'
import { taskSetFinalizationFixture } from '../task-set-finalization-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'
import { realtime } from './mailbox-serialization-fixture.js'

runDatabaseTest('task-set mailbox delivery stamps full basis, private authors and original actor without peer depth', async (t) => {
  const f = await taskSetFinalizationFixture(t)
  await assertGlobalQueuesQuiet(f.prisma)
  const disclosure = { ...f.disclosure,
    disclosureSources: [{ sourceChannelId: f.channel.id, sourceAuthorUserId: f.user.id }] }
  await f.prisma.taskSetItem.update({ where: { taskSetId_sequence: { taskSetId: f.set.id, sequence: 1 } }, data: {
    resultDisclosure: disclosure,
  } })
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    receiver: { agentId: f.receiver.id, channelId: f.channel.id, instructions: 'Write documentation.' },
    deliveryStatus: 'pending',
  } })
  await finalizeTaskSet(f.deps, f.set.id)
  const mail = await f.prisma.agentMailboxMessage.findFirstOrThrow({ where: { taskSetId: f.set.id } })
  await f.prisma.agentMailboxMessage.update({ where: { id: mail.id }, data: { visibleAt: new Date(0) } })
  assert.equal(await dispatchNextMailboxMessage(f.prisma, realtime), true)
  assert.equal((await f.prisma.agentMailboxMessage.findUniqueOrThrow({ where: { id: mail.id } })).status, 'delivered')
  const prompt = await f.prisma.message.findFirstOrThrow({ where: { threadId: f.thread.id, role: 'system' },
    include: { basisScopes: true, disclosureSources: true } })
  assert.deepEqual(prompt.disclosureSources.map(({ sourceChannelId, sourceAuthorUserId }) =>
    ({ sourceChannelId, sourceAuthorUserId })), disclosure.disclosureSources)
  assert.ok(prompt.basisScopes.some((scope) => scope.scopeType === 'user' && scope.scopeId === f.user.id))
  assert.ok(prompt.basisScopes.some((scope) => scope.scopeType === 'channel' && scope.scopeId === f.channel.id))
  const queued = await f.prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey: `mailbox:${mail.id}` } })
  const payload = queued.payload as { actorContext: { actor: { actorId: string; actorType: string };
    actionContext: { effectiveUserId: string; purpose: string; correlationId: string } } }
  assert.deepEqual(payload.actorContext.actor, { actorId: f.user.id, actorType: 'user' })
  assert.equal(payload.actorContext.actionContext.effectiveUserId, f.user.id)
  assert.equal(payload.actorContext.actionContext.purpose, 'task_set.delivery')
  assert.equal(payload.actorContext.actionContext.correlationId, `task-set:${f.set.id}`)
  assert.equal(mail.peerDelegationDepth, null)
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })).status, 'completed')
  assert.equal(await f.prisma.taskSetAttempt.count({ where: { item: { taskSetId: f.set.id } } }), 0)
})
