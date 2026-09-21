import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { registerTaskAttachmentRoutes } from '../src/routes/task-attachments.js'
import { registerUploadRoutes } from '../src/routes/uploads.js'
import { createRouteHarness } from './task-activity-route-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('attachment routes link only the caller\'s uploads and remove through the task door', async (t) => {
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

  // Any project member removes it; an id not on the ticket is a 404.
  h.as(h.ids.secondMemberId)
  const listed = JSON.parse((await h.app.inject({ method: 'GET', url: base })).body).data
  assert.deepEqual(listed.attachments.map((entry: { id: string }) => entry.id), [mine])
  const notOnTask = await h.app.inject({ method: 'DELETE', url: `${base}/${theirs}` })
  assert.equal(notOnTask.statusCode, 404)
  assert.equal(JSON.parse(notOnTask.body).error.code, 'ATTACHMENT_NOT_ON_TASK')
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${mine}` })).statusCode, 204)
  assert.deepEqual(h.deletedFiles, [mine])
  assert.equal(h.published.length, 2)
})
