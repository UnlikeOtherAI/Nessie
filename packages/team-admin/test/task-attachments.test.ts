import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  countTaskAttachments,
  createProjectTask,
  getProjectTask,
  isTaskAccessibleToUser,
  linkTaskAttachments,
  listBoardTasks,
  listTaskAttachments,
  removeTaskAttachment,
  updateProjectTask,
} from '../src/index.js'
import { createUpload, eventsOf, seedTaskActivity } from './task-activity-db-fixture.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('the link doors skip ids the actor did not upload or that are already linked', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const mine = await createUpload(prisma, s, s.memberId)
  const theirs = await createUpload(prisma, s, s.secondMemberId)
  const linked = await linkTaskAttachments(prisma, s.member, {
    taskId: s.nativeTaskId,
    attachmentIds: [mine.id, theirs.id],
  })
  assert.ok(!('error' in linked))
  assert.deepEqual(linked.attachments.map((file) => file.id), [mine.id])
  assert.equal(linked.attachments[0]?.downloadPath, `/api/attachments/${mine.id}`)
  assert.equal((await prisma.attachment.findUniqueOrThrow({ where: { id: theirs.id } })).taskId, null)

  // Already linked: a second link to another ticket moves nothing.
  const again = await linkTaskAttachments(prisma, s.member, { taskId: s.mirroredTaskId, attachmentIds: [mine.id] })
  assert.ok(!('error' in again))
  assert.deepEqual(again.attachments, [])
  assert.deepEqual(await eventsOf(prisma, s.nativeTaskId, 'attachment_added'), [
    { by: s.memberId, attachmentIds: [mine.id] },
  ])

  // The create and update doors link the same way.
  const upload = await createUpload(prisma, s, s.memberId)
  const foreign = await createUpload(prisma, s, s.secondMemberId)
  const created = await createProjectTask(prisma, {
    actorContext: {} as never,
    organizationId: s.organizationId,
    createdByUserId: s.memberId,
    title: 'With image',
    detail: `![](/api/attachments/${upload.id})`,
    projectId: s.projectId,
    attachmentIds: [upload.id, foreign.id],
  })
  assert.ok(!('error' in created))
  assert.equal(created.attachmentCount, 1)
  const late = await createUpload(prisma, s, s.memberId)
  const updated = await updateProjectTask(prisma, {
    taskId: created.id,
    organizationId: s.organizationId,
    fields: { attachmentIds: [late.id, foreign.id] },
    actorId: s.memberId,
  })
  assert.ok(!('error' in updated))
  assert.equal(updated.attachmentCount, 2)
  const listed = await listTaskAttachments(prisma, s.member, { taskId: created.id })
  assert.ok(!('error' in listed))
  assert.deepEqual(
    listed.attachments.map((file) => [file.id, file.inline]).sort(),
    [[upload.id, true], [late.id, false]].sort(),
  )
})

runDatabaseTest('the taskId arm admits a project member and refuses an outsider', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  assert.equal(await isTaskAccessibleToUser(prisma, s.secondMember, s.nativeTaskId), true)
  assert.equal(await isTaskAccessibleToUser(prisma, s.outsider, s.nativeTaskId), false)
  assert.equal(await isTaskAccessibleToUser(prisma, { ...s.outsider, isOrganizationAdmin: true }, s.nativeTaskId), true)
  assert.equal(await isTaskAccessibleToUser(prisma, s.member, 'not-a-uuid'), false)
  await prisma.project.update({ where: { id: s.projectId }, data: { deletedAt: new Date() } })
  assert.equal(
    await isTaskAccessibleToUser(prisma, { ...s.member, isOrganizationAdmin: true }, s.nativeTaskId),
    false,
    'a task goes with its deleted project',
  )
})

runDatabaseTest('anyone who can see the ticket removes a file; the row is marked and the bytes stay', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const upload = await createUpload(prisma, s, s.memberId)
  const kept = await createUpload(prisma, s, s.memberId)
  await linkTaskAttachments(prisma, s.member, { taskId: s.nativeTaskId, attachmentIds: [upload.id, kept.id] })
  assert.deepEqual(
    await removeTaskAttachment(prisma, s.outsider, { taskId: s.nativeTaskId, attachmentId: upload.id }),
    { error: 'NOT_FOUND' },
  )
  assert.deepEqual(
    await removeTaskAttachment(prisma, s.member, { taskId: s.mirroredTaskId, attachmentId: upload.id }),
    { error: 'ATTACHMENT_NOT_ON_TASK' },
  )

  // An organisation admin outside the project sees the ticket, so may remove
  // its file — neither the uploader nor a project member.
  const admin = { ...s.outsider, isOrganizationAdmin: true }
  const removed = await removeTaskAttachment(prisma, admin, {
    taskId: s.nativeTaskId,
    attachmentId: upload.id,
    reason: '  Superseded by v2  ',
  })
  assert.ok(!('error' in removed))
  assert.equal(removed.projectId, s.projectId)
  assert.equal(removed.attachment.id, upload.id)
  assert.equal(removed.attachment.removed?.byUserId, s.outsiderId)
  assert.equal(removed.attachment.removed?.byAgentId, null)
  assert.equal(removed.attachment.removed?.reason, 'Superseded by v2')
  assert.ok(removed.attachment.removed?.at)

  // The row and its bytes stay; the taskId ACL arm still admits a member.
  const row = await prisma.attachment.findUniqueOrThrow({ where: { id: upload.id } })
  assert.equal(row.taskId, s.nativeTaskId)
  assert.equal(row.storageKey, upload.storageKey)
  assert.equal(await isTaskAccessibleToUser(prisma, s.secondMember, row.taskId!), true)

  // A second removal never overwrites the first remover or reason.
  assert.deepEqual(
    await removeTaskAttachment(prisma, s.member, { taskId: s.nativeTaskId, attachmentId: upload.id, reason: 'Mine' }),
    { error: 'ATTACHMENT_ALREADY_REMOVED' },
  )
  assert.equal((await prisma.attachment.findUniqueOrThrow({ where: { id: upload.id } })).removedReason, 'Superseded by v2')

  // The list keeps the removed row, marked; the card's count is live files only.
  const listed = await listTaskAttachments(prisma, s.member, { taskId: s.nativeTaskId })
  assert.ok(!('error' in listed))
  assert.deepEqual(
    listed.attachments.map((file) => [file.id, file.removed?.reason ?? null]).sort(),
    [[upload.id, 'Superseded by v2'], [kept.id, null]].sort(),
  )
  assert.equal((await countTaskAttachments(prisma, [s.nativeTaskId])).get(s.nativeTaskId), 1)
  assert.equal((await getProjectTask(prisma, s.nativeTaskId, s.organizationId))?.attachmentCount, 1)

  assert.deepEqual(await eventsOf(prisma, s.nativeTaskId, 'attachment_removed'), [
    { by: s.outsiderId, attachmentId: upload.id, reason: 'Superseded by v2' },
  ])
})

runDatabaseTest('an unattended agent records itself alone; a blank reason is none', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const upload = await createUpload(prisma, s, s.memberId)
  await linkTaskAttachments(prisma, s.member, { taskId: s.nativeTaskId, attachmentIds: [upload.id] })
  const removed = await removeTaskAttachment(
    prisma,
    { ...s.member, agentId: s.agentId, unattended: true },
    { taskId: s.nativeTaskId, attachmentId: upload.id, reason: '   ' },
  )
  assert.ok(!('error' in removed))
  assert.deepEqual(
    { byUserId: removed.attachment.removed?.byUserId, byAgentId: removed.attachment.removed?.byAgentId, reason: removed.attachment.removed?.reason },
    { byUserId: null, byAgentId: s.agentId, reason: null },
  )
  const [event] = await eventsOf(prisma, s.nativeTaskId, 'attachment_removed')
  assert.equal(event?.['by'], `agent:${s.agentId}`)
  assert.equal(event?.['reason'], null)
})

runDatabaseTest('a provider-stored copy is not removable here', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const stored = await createUpload(prisma, s, s.memberId)
  await prisma.attachment.update({ where: { id: stored.id }, data: { taskId: s.mirroredTaskId } })
  await prisma.taskExternalAsset.create({
    data: {
      organizationId: s.organizationId,
      taskId: s.mirroredTaskId,
      sourceId: s.sourceId,
      externalUrl: 'https://example.test/shot.png',
      kind: 'file',
      status: 'stored',
      attachmentId: stored.id,
    },
  })
  assert.deepEqual(
    await removeTaskAttachment(prisma, s.member, { taskId: s.mirroredTaskId, attachmentId: stored.id }),
    { error: 'ATTACHMENT_NOT_REMOVABLE' },
  )
  assert.equal((await prisma.attachment.findUniqueOrThrow({ where: { id: stored.id } })).removedAt, null)
})

runDatabaseTest('task reads and board cards carry the real attachment count', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const [a, b] = [await createUpload(prisma, s, s.memberId), await createUpload(prisma, s, s.memberId)]
  await linkTaskAttachments(prisma, s.member, { taskId: s.nativeTaskId, attachmentIds: [a.id, b.id] })
  assert.equal((await getProjectTask(prisma, s.nativeTaskId, s.organizationId))?.attachmentCount, 2)
  const board = await prisma.board.findUniqueOrThrow({ where: { id: s.board.id } })
  const { tasks } = await listBoardTasks(prisma, { ...board, columns: [], filter: {} } as never, { limit: 50 })
  assert.equal(tasks.find((task) => task.id === s.nativeTaskId)?.attachmentCount, 2)
})

runDatabaseTest('external assets without a stored copy list as link rows', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  await prisma.taskExternalAsset.create({
    data: {
      organizationId: s.organizationId,
      taskId: s.mirroredTaskId,
      sourceId: s.sourceId,
      externalUrl: 'https://example.test/spec',
      kind: 'link',
      status: 'link',
      title: 'Spec',
    },
  })
  const listed = await listTaskAttachments(prisma, s.member, { taskId: s.mirroredTaskId })
  assert.ok(!('error' in listed))
  assert.equal(listed.attachments.length, 1)
  assert.equal(listed.attachments[0]?.downloadPath, 'https://example.test/spec')
  assert.equal(listed.attachments[0]?.external?.status, 'link')
})
