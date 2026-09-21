import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { COMMENT_REMOVAL_REASON } from '@nessie/schemas'

import {
  createTaskComment,
  deleteTaskComment,
  listTaskComments,
  updateTaskComment,
  type TaskActor,
} from '../src/index.js'
import { createUpload, eventsOf, seedTaskActivity } from './task-activity-db-fixture.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('only a person author edits or deletes their comment', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })

  const created = await createTaskComment(prisma, s.member, { taskId: s.nativeTaskId, body: 'First' })
  assert.ok(!('error' in created))
  assert.deepEqual(created.comment.author, { kind: 'user', userId: s.memberId })
  assert.equal(created.comment.viewerCanEdit, true)
  assert.equal(created.propagated, false)

  // Another project member reads it, and may not change it.
  const seen = await listTaskComments(prisma, s.secondMember, { taskId: s.nativeTaskId })
  assert.ok(!('error' in seen))
  assert.equal(seen.comments[0]?.viewerCanEdit, false)
  const commentId = created.comment.id
  assert.deepEqual(
    await updateTaskComment(prisma, s.secondMember, { taskId: s.nativeTaskId, commentId, body: 'Hijack' }),
    { error: 'COMMENT_NOT_AUTHOR' },
  )
  assert.deepEqual(
    await deleteTaskComment(prisma, s.secondMember, { taskId: s.nativeTaskId, commentId }),
    { error: 'COMMENT_NOT_AUTHOR' },
  )
  // Somebody outside the project cannot even find the task.
  assert.deepEqual(
    await createTaskComment(prisma, s.outsider, { taskId: s.nativeTaskId, body: 'Hi' }),
    { error: 'NOT_FOUND' },
  )

  const edited = await updateTaskComment(prisma, s.member, { taskId: s.nativeTaskId, commentId, body: 'Edited' })
  assert.ok(!('error' in edited))
  assert.equal(edited.comment.body, 'Edited')
  assert.ok(edited.comment.editedAt)

  assert.deepEqual(
    await deleteTaskComment(prisma, s.member, { taskId: s.nativeTaskId, commentId }),
    { ok: true, projectId: s.projectId },
  )
  const row = await prisma.taskComment.findUniqueOrThrow({ where: { id: commentId } })
  assert.equal(row.body, '', 'deletion blanks the body')
  assert.ok(row.deletedAt)
  const after = await listTaskComments(prisma, s.member, { taskId: s.nativeTaskId })
  assert.ok(!('error' in after))
  assert.equal(after.total, 0)

  assert.deepEqual(
    (await eventsOf(prisma, s.nativeTaskId, 'comment_added')).map((payload) => payload['by']),
    [s.memberId],
  )
  assert.deepEqual(await eventsOf(prisma, s.nativeTaskId, 'comment_edited'), [{ by: s.memberId, commentId }])
  assert.deepEqual(await eventsOf(prisma, s.nativeTaskId, 'comment_deleted'), [{ by: s.memberId, commentId }])
})

runDatabaseTest('an agent author owns its comment; the person it acts for does not', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const agentActor: TaskActor = { ...s.member, agentId: s.agentId }
  const created = await createTaskComment(prisma, agentActor, { taskId: s.nativeTaskId, body: 'From the agent' })
  assert.ok(!('error' in created))
  assert.deepEqual(created.comment.author, { kind: 'agent', agentId: s.agentId })
  const [added] = await eventsOf(prisma, s.nativeTaskId, 'comment_added')
  assert.equal(added?.['by'], s.memberId, 'by is the requester')
  assert.equal(added?.['agentId'], s.agentId)

  const commentId = created.comment.id
  // The requester, acting as themselves, is not the author.
  assert.deepEqual(
    await updateTaskComment(prisma, s.member, { taskId: s.nativeTaskId, commentId, body: 'x' }),
    { error: 'COMMENT_NOT_AUTHOR' },
  )
  const edited = await updateTaskComment(prisma, agentActor, { taskId: s.nativeTaskId, commentId, body: 'Agent edit' })
  assert.ok(!('error' in edited))
  const unattended = await createTaskComment(prisma, { ...agentActor, unattended: true }, {
    taskId: s.nativeTaskId, body: 'Nobody asked',
  })
  assert.ok(!('error' in unattended))
  assert.equal((await eventsOf(prisma, s.nativeTaskId, 'comment_added'))[1]?.['by'], `agent:${s.agentId}`)
})

runDatabaseTest('a comment links only its author\'s uploads, and deleting it marks them removed', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const mine = await createUpload(prisma, s, s.memberId)
  const already = await createUpload(prisma, s, s.memberId)
  const theirs = await createUpload(prisma, s, s.secondMemberId)
  const created = await createTaskComment(prisma, s.member, {
    taskId: s.nativeTaskId,
    body: `See ![](/api/attachments/${mine.id})`,
    attachmentIds: [mine.id, already.id, theirs.id],
  })
  assert.ok(!('error' in created))
  assert.deepEqual(
    created.comment.attachments.map((file) => [file.id, file.inline]).sort(),
    [[mine.id, true], [already.id, false]].sort(),
  )
  assert.equal((await prisma.attachment.findUniqueOrThrow({ where: { id: theirs.id } })).taskId, null)
  assert.deepEqual(
    (await eventsOf(prisma, s.nativeTaskId, 'attachment_added')).map((event) => event['commentId']),
    [created.comment.id],
  )
  // Somebody removed one of its files first; that removal stands.
  await prisma.attachment.update({
    where: { id: already.id },
    data: { removedAt: new Date(), removedByUserId: s.secondMemberId, removedReason: 'Wrong file' },
  })

  // No file service is involved: the signature has none to call, and the rows stay.
  await deleteTaskComment(prisma, s.member, { taskId: s.nativeTaskId, commentId: created.comment.id })
  const marked = await prisma.attachment.findUniqueOrThrow({ where: { id: mine.id } })
  assert.ok(marked.removedAt)
  assert.equal(marked.removedByUserId, s.memberId)
  assert.equal(marked.removedReason, COMMENT_REMOVAL_REASON)
  assert.equal(marked.taskId, s.nativeTaskId, 'still on the ticket, still downloadable')
  const untouched = await prisma.attachment.findUniqueOrThrow({ where: { id: already.id } })
  assert.equal(untouched.removedByUserId, s.secondMemberId)
  assert.equal(untouched.removedReason, 'Wrong file')
  assert.equal(await prisma.attachment.count({ where: { id: theirs.id } }), 1)
  assert.deepEqual(await eventsOf(prisma, s.nativeTaskId, 'attachment_removed'), [
    { by: s.memberId, attachmentId: mine.id, reason: COMMENT_REMOVAL_REASON, commentId: created.comment.id },
  ])
})

runDatabaseTest('on a mirrored ticket a comment follows the source\'s write mode', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma, { writeMode: 'read_write' })
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  const calls: string[] = []
  const writeBack = {
    createComment: async ({ body }: { taskId: string; body: string }) => {
      calls.push(`create:${body}`)
      const now = new Date().toISOString()
      return {
        ok: true as const,
        comment: {
          externalId: 'lin-comment-1', issueExternalId: 'x', body: `${body} (echo)`, author: null,
          createdAt: now, updatedAt: now, url: 'https://linear.app/c/1',
        },
      }
    },
  }
  const created = await createTaskComment(prisma, s.member, { taskId: s.mirroredTaskId, body: 'Up' }, { writeBack })
  assert.ok(!('error' in created))
  assert.equal(created.propagated, true)
  assert.equal(created.comment.body, 'Up (echo)', 'the row is written from the echo')
  assert.deepEqual(created.comment.external, {
    sourceId: s.sourceId, provider: 'linear', externalId: 'lin-comment-1', url: 'https://linear.app/c/1',
  })
  // An adapter that cannot edit comments: the imported comment is not writable.
  assert.deepEqual(
    await updateTaskComment(prisma, s.member, {
      taskId: s.mirroredTaskId, commentId: created.comment.id, body: 'x',
    }, { writeBack }),
    { error: 'COMMENT_NOT_WRITABLE' },
  )

  // A read-only source keeps new comments local and refuses changes to imported ones.
  await prisma.boardSource.update({ where: { id: s.sourceId }, data: { writeMode: 'read_only' } })
  const local = await createTaskComment(prisma, s.member, { taskId: s.mirroredTaskId, body: 'Local' }, { writeBack })
  assert.ok(!('error' in local))
  assert.equal(local.comment.external, null)
  assert.equal(calls.length, 1)
  const refused = await deleteTaskComment(prisma, s.member, {
    taskId: s.mirroredTaskId, commentId: created.comment.id,
  })
  assert.ok('error' in refused && refused.error === 'SOURCE_READ_ONLY')
})

runDatabaseTest('comments page oldest first on a keyset cursor', async (t) => {
  const prisma = new PrismaClient()
  const s = await seedTaskActivity(prisma)
  t.after(async () => {
    await s.cleanup()
    await prisma.$disconnect()
  })
  for (const body of ['a', 'b', 'c']) {
    await createTaskComment(prisma, s.member, { taskId: s.nativeTaskId, body })
    // createdAt is millisecond-precise; keep the three apart so order is by time.
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const first = await listTaskComments(prisma, s.member, { taskId: s.nativeTaskId, limit: 2 })
  assert.ok(!('error' in first))
  assert.deepEqual(first.comments.map((comment) => comment.body), ['a', 'b'])
  assert.equal(first.total, 3)
  assert.ok(first.nextCursor)
  const second = await listTaskComments(prisma, s.member, { taskId: s.nativeTaskId, cursor: first.nextCursor, limit: 2 })
  assert.ok(!('error' in second))
  assert.deepEqual(second.comments.map((comment) => comment.body), ['c'])
  assert.equal(second.nextCursor, null)
  assert.deepEqual(
    await listTaskComments(prisma, s.member, { taskId: s.nativeTaskId, cursor: 'garbage' }),
    { error: 'CURSOR_INVALID' },
  )
})
