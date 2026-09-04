import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { CreateThreadMessageBodySchema } from '../src/contracts.js'
import { storeFile, withHarness } from './message-attachment-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const attachmentId = () => randomUUID()

const multipartBody = (
  filename: string,
  mime: string,
  content: string,
): { body: Buffer; boundary: string } => {
  const boundary = `----nessie-${randomUUID()}`
  return {
    boundary,
    body: Buffer.from([
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
      `Content-Type: ${mime}\r\n\r\n`,
      content,
      `\r\n--${boundary}--\r\n`,
    ].join('')),
  }
}

// ─── Body contract: attachment-only posts, and the linked-id cap ────────────

test('message body accepts attachments without any text', () => {
  const parsed = CreateThreadMessageBodySchema.safeParse({
    attachmentIds: [attachmentId()],
  })

  assert.equal(parsed.success, true)
})

test('message body rejects neither text nor attachments', () => {
  assert.equal(CreateThreadMessageBodySchema.safeParse({}).success, false)
  assert.equal(CreateThreadMessageBodySchema.safeParse({ content: '' }).success, false)
  assert.equal(CreateThreadMessageBodySchema.safeParse({ content: '   ' }).success, false)
  assert.equal(
    CreateThreadMessageBodySchema.safeParse({ content: '  ', attachmentIds: [] }).success,
    false,
  )
})

test('message body caps linked attachments at ten', () => {
  const ten = Array.from({ length: 10 }, attachmentId)
  assert.equal(CreateThreadMessageBodySchema.safeParse({ attachmentIds: ten }).success, true)
  assert.equal(
    CreateThreadMessageBodySchema.safeParse({ attachmentIds: [...ten, attachmentId()] })
      .success,
    false,
  )
})

// ─── Route behaviour against a real database ────────────────────────────────

runDatabaseTest('an attachment-only message is created and linked', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { attachmentIds: [attachment.id] },
      })

      assert.equal(response.statusCode, 201)
      const body = response.json() as { data: { message: { id: string; content: string } } }
      assert.equal(body.data.message.content, '')
      const linked = await prisma.attachment.findUnique({ where: { id: attachment.id } })
      assert.equal(linked?.messageId, body.data.message.id)
    },
  )
})

runDatabaseTest('a message with neither text nor attachments is rejected', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, seed }) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: '   ' },
      })

      assert.equal(response.statusCode, 400)
    },
  )
})

runDatabaseTest('credential-bearing message text is rejected before persistence', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, prisma, seed }) => {
      const before = await prisma.message.count({ where: { threadId: seed.threadId } })
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'client_secret="abcdefghijklmnopqrstuv"' },
      })

      assert.equal(response.statusCode, 422)
      assert.equal(response.json().error.code, 'SECRET_INTERCEPTED')
      assert.equal(await prisma.message.count({ where: { threadId: seed.threadId } }), before)
    },
  )
})

runDatabaseTest('credential-bearing filenames are rejected before object storage', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, prisma, seed }) => {
      const token = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
      const multipart = multipartBody(`${token}.txt`, 'text/plain', 'ordinary content')
      const response = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { 'content-type': `multipart/form-data; boundary=${multipart.boundary}` },
        payload: multipart.body,
      })

      assert.equal(response.statusCode, 422)
      assert.equal(response.json().error.code, 'SECRET_INTERCEPTED')
      assert.equal(
        await prisma.attachment.count({ where: { organizationId: seed.organizationId } }),
        0,
      )
    },
  )
})

runDatabaseTest('more than ten attachment ids is rejected', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, seed }) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'many', attachmentIds: Array.from({ length: 11 }, attachmentId) },
      })

      assert.equal(response.statusCode, 400)
    },
  )
})

runDatabaseTest('linking skips an attachment uploaded by another member', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const mine = await storeFile(fileService, seed, seed.senderId, 'mine.txt')
      const theirs = await storeFile(fileService, seed, seed.otherUserId, 'theirs.txt')

      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: {
          content: 'with files',
          attachmentIds: [mine.attachment.id, theirs.attachment.id],
        },
      })

      assert.equal(response.statusCode, 201)
      const messageId = (response.json() as { data: { message: { id: string } } }).data.message.id
      const linkedMine = await prisma.attachment.findUnique({ where: { id: mine.attachment.id } })
      const linkedTheirs = await prisma.attachment.findUnique({
        where: { id: theirs.attachment.id },
      })
      assert.equal(linkedMine?.messageId, messageId)
      assert.equal(linkedTheirs?.messageId, null)
    },
  )
})

runDatabaseTest('the uploader can delete their own unlinked attachment', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })

      assert.equal(response.statusCode, 204)
      assert.equal(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null)
      const events = await prisma.storageUsageEvent.findMany({
        where: { attachmentId: attachment.id },
        orderBy: { occurredAt: 'asc' },
      })
      const deltas = events.map((event) => event.deltaBytes)
      assert.deepEqual(deltas, [11n, -11n])
    },
  )
})

runDatabaseTest('a linked attachment cannot be deleted', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)
      const created = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'keep', attachmentIds: [attachment.id] },
      })
      assert.equal(created.statusCode, 201)

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })

      assert.equal(response.statusCode, 404)
      assert.notEqual(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null)
    },
  )
})

runDatabaseTest('another member cannot delete an attachment they did not upload', async () => {
  await withHarness(
    (seed) => seed.otherUserId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })

      assert.equal(response.statusCode, 404)
      assert.notEqual(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null)
    },
  )
})
