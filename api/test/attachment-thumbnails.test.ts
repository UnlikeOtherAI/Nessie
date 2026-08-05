import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { FileService } from '@nessie/runtime'

import { type Seed, storeFile, withHarness } from './message-attachment-harness.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

// Store a real (tiny) image so the FileService generates a thumbnail inline.
const storeImage = async (fileService: FileService, seed: Seed, uploaderId: string) => {
  const sharp = (await import('sharp')).default
  const png = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 3, g: 100, b: 200 } },
  })
    .png()
    .toBuffer()
  return fileService.store({
    attribution: {
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      actorId: uploaderId,
      actorType: 'user',
    },
    organizationId: seed.organizationId,
    uploaderId,
    filename: 'photo.png',
    mime: 'image/png',
    body: Readable.from(png),
  })
}

runDatabaseTest('attachment bytes are immutably cacheable and revalidate to 304', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const first = await app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}` })
      assert.equal(first.statusCode, 200)
      assert.equal(first.headers['cache-control'], 'private, max-age=31536000, immutable')
      const etag = first.headers.etag as string
      assert.ok(etag, 'a strong validator is sent')
      assert.ok(first.headers['last-modified'])

      // The browser's revalidation: no bytes come back.
      const revalidated = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.id}`,
        headers: { 'if-none-match': etag },
      })
      assert.equal(revalidated.statusCode, 304)
      assert.equal(revalidated.body, '')
      // A wildcard matches any current representation (RFC 9110).
      const wildcard = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.id}`,
        headers: { 'if-none-match': '*' },
      })
      assert.equal(wildcard.statusCode, 304)
      // A stale validator must still transfer.
      const stale = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.id}`,
        headers: { 'if-none-match': '"something-else"' },
      })
      assert.equal(stale.statusCode, 200)
    },
  )
})

runDatabaseTest('the thumbnail endpoint serves the preview and 404s when absent', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const image = await storeImage(fileService, seed, seed.senderId)
      assert.ok(image.attachment.thumbnailKey, 'an image is thumbnailed inline at store time')

      const response = await app.inject({
        method: 'GET',
        url: `/api/attachments/${image.attachment.id}/thumbnail`,
      })
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['content-type'], 'image/webp')
      assert.equal(response.headers['cache-control'], 'private, max-age=31536000, immutable')
      // The point of the whole feature: the preview is far smaller.
      assert.ok(
        response.rawPayload.length < Number(image.attachment.sizeBytes),
        `${response.rawPayload.length} < ${image.attachment.sizeBytes}`,
      )
      // Its validator is distinct from the original's, so the two URLs cannot
      // revalidate into each other.
      const original = await app.inject({
        method: 'GET',
        url: `/api/attachments/${image.attachment.id}`,
      })
      assert.notEqual(response.headers.etag, original.headers.etag)

      // Both objects are metered, with the preview separately auditable.
      const events = await prisma.storageUsageEvent.findMany({
        where: { attachmentId: image.attachment.id },
        orderBy: { occurredAt: 'asc' },
      })
      assert.deepEqual(
        events.map((event) => event.operation),
        ['store', 'store.thumbnail'],
      )

      // A file with no preview 404s so the client falls back.
      const text = await storeFile(fileService, seed, seed.senderId)
      const missing = await app.inject({
        method: 'GET',
        url: `/api/attachments/${text.attachment.id}/thumbnail`,
      })
      assert.equal(missing.statusCode, 404)
    },
  )
})

runDatabaseTest('deleting an attachment frees the thumbnail and both usage events', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeImage(fileService, seed, seed.senderId)
      const thumbnailBytes = attachment.thumbnailSizeBytes as bigint

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/attachments/${attachment.id}`,
      })
      assert.equal(response.statusCode, 204)

      const events = await prisma.storageUsageEvent.findMany({
        where: { attachmentId: attachment.id },
        orderBy: { occurredAt: 'asc' },
      })
      assert.deepEqual(
        events.map((event) => event.operation),
        ['store', 'store.thumbnail', 'delete', 'delete.thumbnail'],
      )
      assert.equal(
        events.reduce((total, event) => total + event.deltaBytes, 0n),
        0n,
        'stored bytes net to zero',
      )
      assert.equal(
        events.find((event) => event.operation === 'delete.thumbnail')?.deltaBytes,
        -thumbnailBytes,
      )
      // Both objects are gone from storage.
      assert.equal(await fileService.openStream(attachment.id, seed.organizationId), null)
      assert.equal(
        await fileService.openThumbnailStream(attachment.id, seed.organizationId),
        null,
      )
    },
  )
})

runDatabaseTest('a message carries its attachment count so the feed can skip fetching', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, seed }) => {
      const { attachment } = await storeFile(fileService, seed, seed.senderId)

      const withFile = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'here', attachmentIds: [attachment.id] },
      })
      assert.equal(withFile.statusCode, 201)
      assert.equal(
        (withFile.json() as { data: { message: { attachmentCount: number } } }).data.message
          .attachmentCount,
        1,
      )

      const plain = await app.inject({
        method: 'POST',
        url: `/api/threads/${seed.threadId}/messages`,
        payload: { content: 'no files' },
      })
      assert.equal(plain.statusCode, 201)
      assert.equal(
        (plain.json() as { data: { message: { attachmentCount: number } } }).data.message
          .attachmentCount,
        0,
      )
    },
  )
})

runDatabaseTest('the thumbnail endpoint refuses a knowledge-base blob', async () => {
  await withHarness(
    (seed) => seed.senderId,
    async ({ app, fileService, prisma, seed }) => {
      const { attachment } = await storeImage(fileService, seed, seed.senderId)
      // Same ACL as the original download: the generic attachment routes
      // deliberately do not serve KB blobs (their own routes enforce space
      // access), and the thumbnail must not be a way around that.
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { knowledgePageId: randomUUID() },
      })

      const thumbnail = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.id}/thumbnail`,
      })
      const original = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.id}`,
      })
      assert.equal(thumbnail.statusCode, 404)
      assert.equal(original.statusCode, 404)
    },
  )
})
