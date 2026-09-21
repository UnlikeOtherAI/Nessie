import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { registerTaskCommentRoutes } from '../src/routes/task-comments.js'
import { createRouteHarness } from './task-activity-route-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('comment routes: any reader comments, only the author edits or deletes', async (t) => {
  const prisma = new PrismaClient()
  const h = await createRouteHarness(prisma, [registerTaskCommentRoutes])
  t.after(async () => {
    await h.close()
    await prisma.$disconnect()
  })
  const base = `/api/tasks/${h.ids.taskId}/comments`
  const file = await h.upload(h.ids.memberId)

  const created = await h.app.inject({
    method: 'POST', url: base, payload: { body: 'Hello', attachmentIds: [file] },
  })
  assert.equal(created.statusCode, 201, created.body)
  const comment = JSON.parse(created.body).data
  assert.deepEqual(comment.author, { kind: 'user', userId: h.ids.memberId })
  assert.deepEqual(comment.attachments.map((entry: { id: string }) => entry.id), [file])
  assert.deepEqual(h.published, [
    { event: 'task.activity', data: { taskId: h.ids.taskId, projectId: h.ids.projectId } },
  ])

  h.as(h.ids.secondMemberId)
  const listed = JSON.parse((await h.app.inject({ method: 'GET', url: base })).body).data
  assert.equal(listed.total, 1)
  assert.equal(listed.comments[0].viewerCanEdit, false)
  const hijack = await h.app.inject({ method: 'PATCH', url: `${base}/${comment.id}`, payload: { body: 'Mine now' } })
  assert.equal(hijack.statusCode, 403)
  assert.equal(JSON.parse(hijack.body).error.code, 'COMMENT_NOT_AUTHOR')
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${comment.id}` })).statusCode, 403)

  h.as(h.ids.outsiderId)
  assert.equal((await h.app.inject({ method: 'GET', url: base })).statusCode, 404)
  assert.equal((await h.app.inject({ method: 'POST', url: base, payload: { body: 'Hi' } })).statusCode, 404)

  h.as(h.ids.memberId)
  const edited = await h.app.inject({ method: 'PATCH', url: `${base}/${comment.id}`, payload: { body: 'Edited' } })
  assert.equal(edited.statusCode, 200, edited.body)
  assert.ok(JSON.parse(edited.body).data.editedAt)
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${comment.id}` })).statusCode, 204)
  assert.deepEqual(h.deletedFiles, [file], 'the comment\'s file went through the file service')
  assert.equal((await h.app.inject({ method: 'DELETE', url: `${base}/${comment.id}` })).statusCode, 404)
  assert.equal(h.published.filter((event) => event.event === 'task.activity').length, 3)

  assert.equal((await h.app.inject({ method: 'GET', url: `${base}?cursor=nope` })).statusCode, 400)
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/tasks/not-a-uuid/comments' })).statusCode, 404)
})
