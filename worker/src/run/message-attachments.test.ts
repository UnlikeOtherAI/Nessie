import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { FileService } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import {
  describeAttachments,
  loadInlineImages,
  loadMessageAttachments,
  type MessageAttachment,
} from './message-attachments.js'

const ORGANIZATION_ID = '00000000-0000-0000-0000-0000000000c1'

const attachment = (overrides: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: 'att-1',
  filename: 'gallus.png',
  kind: 'image',
  mime: 'image/png',
  sizeBytes: 812n * 1024n,
  thumbnailKey: 'org/key.thumb.webp',
  ...overrides,
})

type OpenCall = { id: string; source: 'original' | 'thumbnail' }

const makeFiles = (
  bytes: Record<string, Buffer | null> = {},
): { files: FileService; calls: OpenCall[] } => {
  const calls: OpenCall[] = []
  const open = (source: 'original' | 'thumbnail', mime: string) =>
    async (attachmentId: string) => {
      calls.push({ id: attachmentId, source })
      const data = bytes[`${source}:${attachmentId}`]
      return data ? { stream: Readable.from([data]), attachment: { mime } } : null
    }

  return {
    calls,
    files: {
      openStream: open('original', 'image/png'),
      openThumbnailStream: open('thumbnail', 'image/webp'),
    } as unknown as FileService,
  }
}

test('the inventory line names every file so an image-only turn is not empty', () => {
  const note = describeAttachments([
    attachment(),
    attachment({ id: 'att-2', filename: 'notes.pdf', mime: 'application/pdf', sizeBytes: 4096n }),
  ])
  assert.equal(
    note,
    '[attached: gallus.png (image/png, 812 KB, id=att-1); notes.pdf (application/pdf, 4 KB, id=att-2)]',
  )
})

test('a message with no files gets no inventory line', () => {
  assert.equal(describeAttachments([]), null)
})

test('a directly decodable image is inlined from the original bytes', async () => {
  const { files, calls } = makeFiles({ 'original:att-1': Buffer.from([1, 2, 3]) })
  const images = await loadInlineImages(
    files,
    ORGANIZATION_ID,
    ['m1'],
    new Map([['m1', [attachment()]]]),
  )
  assert.deepEqual(calls, [{ id: 'att-1', source: 'original' }])
  assert.deepEqual(images.get('m1'), [
    { dataBase64: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/png' },
  ])
})

test('a format no provider decodes reaches the model through its stored preview', async () => {
  const { files, calls } = makeFiles({ 'thumbnail:att-1': Buffer.from([9]) })
  const images = await loadInlineImages(
    files,
    ORGANIZATION_ID,
    ['m1'],
    new Map([['m1', [attachment({ filename: 'IMG.heic', mime: 'image/heic' })]]]),
  )
  assert.deepEqual(calls, [{ id: 'att-1', source: 'thumbnail' }])
  assert.equal(images.get('m1')?.[0]?.mime, 'image/webp')
})

test('an oversized original falls back to the preview rather than base64-ing 20 MB', async () => {
  const { files, calls } = makeFiles({ 'thumbnail:att-1': Buffer.from([9]) })
  await loadInlineImages(
    files,
    ORGANIZATION_ID,
    ['m1'],
    new Map([['m1', [attachment({ sizeBytes: 20n * 1024n * 1024n })]]]),
  )
  assert.deepEqual(calls, [{ id: 'att-1', source: 'thumbnail' }])
})

test('a non-image file is never inlined', async () => {
  const { files, calls } = makeFiles()
  const images = await loadInlineImages(
    files,
    ORGANIZATION_ID,
    ['m1'],
    new Map([['m1', [attachment({ mime: 'application/pdf' })]]]),
  )
  assert.equal(calls.length, 0)
  assert.equal(images.size, 0)
})

test('an image with neither usable original nor preview is skipped, not fatal', async () => {
  const { files } = makeFiles()
  const images = await loadInlineImages(
    files,
    ORGANIZATION_ID,
    ['m1'],
    new Map([['m1', [attachment({ mime: 'image/svg+xml', thumbnailKey: null })]]]),
  )
  assert.equal(images.size, 0)
})

test('storage failures cost the picture, never the run', async () => {
  const files = {
    openStream: async () => {
      throw new Error('storage unreachable')
    },
    openThumbnailStream: async () => null,
  } as unknown as FileService
  const images = await loadInlineImages(
    files,
    ORGANIZATION_ID,
    ['m1'],
    new Map([['m1', [attachment()]]]),
  )
  assert.equal(images.size, 0)
})

test('when a window holds more images than fit, the newest messages win the budget', async () => {
  const messageIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']
  const byMessage = new Map<string, MessageAttachment[]>(
    messageIds.map((id) => [id, [attachment({ id: `att-${id}` })]]),
  )
  const bytes = Object.fromEntries(
    messageIds.map((id) => [`original:att-${id}`, Buffer.from([1])]),
  )
  const { files } = makeFiles(bytes)

  const images = await loadInlineImages(files, ORGANIZATION_ID, messageIds, new Map(byMessage))

  assert.equal([...images.values()].flat().length, 6)
  assert.equal(images.has('m8'), true)
  assert.equal(images.has('m3'), true)
  assert.equal(images.has('m2'), false)
  assert.equal(images.has('m1'), false)
})

test('attachments are grouped by their message', async () => {
  const prisma = {
    attachment: {
      findMany: async () => [
        { ...attachment(), messageId: 'm1' },
        { ...attachment({ id: 'att-2' }), messageId: 'm1' },
        { ...attachment({ id: 'att-3' }), messageId: 'm2' },
      ],
    },
  } as unknown as PrismaClient

  const byMessage = await loadMessageAttachments(prisma, ORGANIZATION_ID, ['m1', 'm2'])
  assert.equal(byMessage.get('m1')?.length, 2)
  assert.equal(byMessage.get('m2')?.length, 1)
})

test('an empty window never queries storage or the attachment table', async () => {
  const prisma = {
    attachment: {
      findMany: async () => {
        throw new Error('should not be queried')
      },
    },
  } as unknown as PrismaClient
  assert.equal((await loadMessageAttachments(prisma, ORGANIZATION_ID, [])).size, 0)
})
