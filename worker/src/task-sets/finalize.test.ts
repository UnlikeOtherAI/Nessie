import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@prisma/client'
import { taskSetFinalizationFixture } from '../../test/task-set-finalization-fixture.js'
import { finalizeTaskSet } from './finalize.js'
import { claimTaskSetFinalization, updateTaskSetFinalization } from './finalization-state.js'
import { TaskSetBlocked, TaskSetWait } from './state.js'
import { authorizeTaskSetMailbox } from '../control/task-set-mailbox.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

dbTest('journal completion requires sealed input and terminal items, then reads more than one bounded page', async (t) => {
  const f = await taskSetFinalizationFixture(t, 405)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: { inputClosedAt: null } })
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })).status, 'running')
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: { inputClosedAt: new Date() } })
  await f.prisma.taskSetItem.update({ where: { taskSetId_sequence: { taskSetId: f.set.id, sequence: 405 } },
    data: { status: 'failed' } })
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })).status, 'running')
  await f.prisma.taskSetItem.update({ where: { taskSetId_sequence: { taskSetId: f.set.id, sequence: 405 } },
    data: { status: 'skipped', result: null } })
  await finalizeTaskSet(f.deps, f.set.id)
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })).status, 'completed')
  assert.equal(f.stored(), 0)
  assert.equal(await f.prisma.taskSetAttempt.count({ where: { item: { taskSetId: f.set.id } } }), 0)
})

dbTest('a finalization lease excludes a second worker and fences the first after takeover', async (t) => {
  const f = await taskSetFinalizationFixture(t)
  const first = await claimTaskSetFinalization(f.prisma, f.set.id)
  assert.ok(first)
  await assert.rejects(claimTaskSetFinalization(f.prisma, f.set.id), TaskSetWait)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    outputState: { ...first.state, lease: { token: first.token, until: new Date(0).toISOString() } },
  } })
  const second = await claimTaskSetFinalization(f.prisma, f.set.id)
  assert.ok(second)
  await assert.rejects(updateTaskSetFinalization(f.prisma, first, { finished: true }), /output_claim_lost/)
  await updateTaskSetFinalization(f.prisma, second, { release: true })
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })).status, 'completed')
})

dbTest('a crash after the output receipt reuses one attachment and one document, preserving disclosure', async (t) => {
  const f = await taskSetFinalizationFixture(t)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    output: { kind: 'documents', spaceId: f.space.id, format: 'jsonl' },
  } })
  f.crashAfterReceipt()
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /simulated crash/)
  assert.equal(f.stored(), 1)
  await finalizeTaskSet(f.deps, f.set.id)
  await finalizeTaskSet(f.deps, f.set.id)
  const completed = await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })
  assert.equal(completed.status, 'completed')
  assert.ok(completed.outputPageId)
  assert.equal(f.stored(), 1)
  assert.equal(await f.prisma.knowledgePage.count({ where: { spaceId: f.space.id } }), 1)
  const version = await f.prisma.knowledgePageVersion.findFirstOrThrow({ where: { pageId: completed.outputPageId } })
  assert.deepEqual(await f.prisma.knowledgePageVersionBasisScope.findMany({
    where: { versionId: version.id }, select: { scopeType: true, scopeId: true },
  }), f.disclosure.basisScopes)
})

dbTest('receiver retry keeps one mailbox handoff and never reruns completed items', async (t) => {
  const f = await taskSetFinalizationFixture(t)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    receiver: { agentId: f.receiver.id, channelId: f.channel.id, instructions: 'Write a final report.' },
    deliveryStatus: 'pending',
  } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /receiver_delivery_pending/)
  const mail = await f.prisma.agentMailboxMessage.findFirstOrThrow({ where: { taskSetId: f.set.id } })
  assert.equal(mail.peerDelegationDepth, null)
  assert.equal(mail.correlationId, `task-set:${f.set.id}`)
  assert.deepEqual(mail.basis, f.disclosure.basisScopes)
  assert.equal(await authorizeTaskSetMailbox(f.prisma, { ...mail, taskSetId: f.set.id, toAgentId: f.receiver.id }), 'ready')
  await f.prisma.agentMailboxMessage.update({ where: { id: mail.id }, data: { status: 'dead_letter' } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /receiver_delivery_failed/)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: { status: 'blocked' } })
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.agentMailboxMessage.findUniqueOrThrow({ where: { id: mail.id } })).status, 'dead_letter')
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: { status: 'running' } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /receiver_delivery_pending/)
  assert.equal(await f.prisma.agentMailboxMessage.count({ where: { taskSetId: f.set.id } }), 1)
  await f.prisma.agentMailboxMessage.update({ where: { id: mail.id }, data: { status: 'delivered' } })
  await finalizeTaskSet(f.deps, f.set.id)
  assert.equal((await f.prisma.taskSet.findUniqueOrThrow({ where: { id: f.set.id } })).deliveryStatus, 'delivered')
  assert.equal(await f.prisma.taskSetAttempt.count({ where: { item: { taskSetId: f.set.id } } }), 0)
})

dbTest('revocation, unclassified results, shared export and machine-restricted destinations fail closed', async (t) => {
  const f = await taskSetFinalizationFixture(t)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    output: { kind: 'documents', spaceId: f.space.id, format: 'text' },
  } })
  await f.prisma.knowledgeSpace.update({ where: { id: f.space.id }, data: { sensitivityTier: 'restricted' } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), TaskSetBlocked)
  assert.equal(f.stored(), 0)
  await f.prisma.taskSet.update({ where: { id: f.set.id }, data: {
    output: { kind: 'journal' }, receiver: { agentId: f.receiver.id, channelId: f.channel.id, instructions: 'Report.' },
  } })
  await f.prisma.taskSetItem.update({ where: { taskSetId_sequence: { taskSetId: f.set.id, sequence: 1 } },
    data: { resultDisclosure: Prisma.DbNull } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /result_not_classified/)
  await f.prisma.taskSetItem.update({ where: { taskSetId_sequence: { taskSetId: f.set.id, sequence: 1 } },
    data: { resultDisclosure: f.disclosure } })
  await f.prisma.channel.update({ where: { id: f.channel.id }, data: { visibility: 'public' } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /receiver_source_access_required/)
  assert.equal(await f.prisma.agentMailboxMessage.count({ where: { taskSetId: f.set.id } }), 0)
  await f.prisma.organizationMember.update({ where: {
    organizationId_userId: { organizationId: f.org.id, userId: f.user.id },
  }, data: { deactivatedAt: new Date() } })
  await assert.rejects(finalizeTaskSet(f.deps, f.set.id), /reauthorization/)
})
