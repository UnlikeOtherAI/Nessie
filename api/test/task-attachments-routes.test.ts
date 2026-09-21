import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { registerTaskAttachmentRoutes } from '../src/routes/task-attachments.js'
import { registerUploadRoutes } from '../src/routes/uploads.js'
import { createRouteHarness } from './task-activity-route-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('attachment routes link only the caller\'s uploads and remove by marking, through the task door', async (t) => {
  const prisma = new PrismaClient()
  const h = await createRouteHarness(prisma, [registerTaskAttachmentRoutes, registerUploadRoutes])
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })
  const base = `/api/tasks/${h.ids.taskId}/attachments`
  const mine = await h.upload(h.ids.memberId)
  const theirs = await h.upload(h.ids.secondMemberId)

  const linked = await h.app.inject({ method: 'POST', url: base, payload: { attachmentIds: [mine, theirs] } })
  assert.equal(linked.statusCode, 200, linked.body)
  assert.deepEqual(JSON.parse(linked.body).data.attachments.map((entry: { id: string }) => entry.id), [mine])
  assert.deepEqual(h.published, [
    { event: 'task.activity', data: { taskId: h.ids.taskId, projectId: h.ids.projectId } },
  ])

  // The discard-my-upload door refuses a file that is on a ticket.
  const discard = await h.app.inject({ method: 'DELETE', url: `/api/attachments/${mine}` })
  assert.equal(discard.statusCode, 404)
  assert.equal(await prisma.attachment.count({ where: { id: mine } }), 1)

  h.as(h.ids.outsiderId)
  assert.equal((await h.app.inject({ method: 'GET', url: base })).statusCode, 404)
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${mine}` })).statusCode, 404)

  // Anyone who can see the ticket removes it; an id not on the ticket is a 404.
  h.as(h.ids.secondMemberId)
  const listed = JSON.parse((await h.app.inject({ method: 'GET', url: base })).body).data
  assert.deepEqual(listed.attachments.map((entry: { id: string }) => entry.id), [mine])
  const notOnTask = await h.app.inject({ method: 'DELETE', url: `${base}/${theirs}` })
  assert.equal(notOnTask.statusCode, 404)
  assert.equal(JSON.parse(notOnTask.body).error.code, 'ATTACHMENT_NOT_ON_TASK')

  // A reason longer than 500 characters is a 400 before anything is written.
  const tooLong = await h.app.inject({ method: 'DELETE', url: `${base}/${mine}`, payload: { reason: 'x'.repeat(501) } })
  assert.equal(tooLong.statusCode, 400)

  const removed = await h.app.inject({ method: 'DELETE', url: `${base}/${mine}`, payload: { reason: 'Superseded by v2' } })
  assert.equal(removed.statusCode, 200, removed.body)
  const record = JSON.parse(removed.body).data
  assert.equal(record.id, mine)
  assert.equal(record.removed.byUserId, h.ids.secondMemberId)
  assert.equal(record.removed.byAgentId, null)
  assert.equal(record.removed.reason, 'Superseded by v2')
  assert.deepEqual(h.deletedFiles, [], 'removal never reaches the file service')
  assert.equal(await prisma.attachment.count({ where: { id: mine } }), 1)

  // The list keeps it, marked; a second removal is a 409 and changes nothing.
  const after = JSON.parse((await h.app.inject({ method: 'GET', url: base })).body).data
  assert.equal(after.attachments[0].removed.reason, 'Superseded by v2')
  h.as(h.ids.memberId)
  const again = await h.app.inject({ method: 'DELETE', url: `${base}/${mine}` })
  assert.equal(again.statusCode, 409)
  assert.equal(JSON.parse(again.body).error.code, 'ATTACHMENT_ALREADY_REMOVED')
  assert.equal(h.published.length, 2)

  // A bare DELETE, no body at all, is a removal without a reason.
  const second = await h.upload(h.ids.memberId)
  await h.app.inject({ method: 'POST', url: base, payload: { attachmentIds: [second] } })
  const bare = await h.app.inject({ method: 'DELETE', url: `${base}/${second}` })
  assert.equal(bare.statusCode, 200, bare.body)
  assert.equal(JSON.parse(bare.body).data.removed.reason, null)
})
