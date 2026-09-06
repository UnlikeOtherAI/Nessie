import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import sharp from 'sharp'

import { createFileService } from '../src/files/index.js'
import {
  IMAGE_STRIP_MAX_BYTES,
  prepareImageUpload,
} from '../src/files/strip-image-metadata.js'
import { collectStream, type Storage } from '../src/storage/index.js'

const ORG = '00000000-0000-4000-8000-000000000001'

const attribution = { organizationId: ORG, actorId: 'user-1', actorType: 'user' as const }

// Minimal valid ICC profile (Adobe RGB 1998) so ICC-preservation can be
// asserted byte-for-byte through the strip pipeline.
const ICC_PROFILE = Buffer.from(
  'AAACMEFEQkUCEAAAbW50clJHQiBYWVogB9AACAALABMAMwA7YWNzcEFQUEwAAAAAbm9uZQAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1BREJFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKY3BydAAAAPwAAAAyZGVzYwAAATAAAABrd3RwdAAAAZwAAAAUYmtwdAAAAbAAAAAUclRSQwAAAcQAAAAOZ1RSQwAAAdQAAAAOYlRSQwAAAeQAAAAOclhZWgAAAfQAAAAUZ1hZWgAAAggAAAAUYlhZWgAAAhwAAAAUdGV4dAAAAABDb3B5cmlnaHQgMjAwMCBBZG9iZSBTeXN0ZW1zIEluY29ycG9yYXRlZAAAAGRlc2MAAAAAAAAAEUFkb2JlIFJHQiAoMTk5OCkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAADzUQABAAAAARbMWFlaIAAAAAAAAAAAAAAAAAAAAABjdXJ2AAAAAAAAAAECMwAAY3VydgAAAAAAAAABAjMAAGN1cnYAAAAAAAAAAQIzAABYWVogAAAAAAAAnBgAAE+lAAAE/FhZWiAAAAAAAAA0jQAAoCwAAA+VWFlaIAAAAAAAACYxAAAQLwAAvpw=',
  'base64',
)

// In-memory Storage that records bytes per key.
const makeStorage = (): Storage & { blobs: Map<string, Buffer> } => {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    putStream: async (key, body) => {
      const buf = await collectStream(body)
      blobs.set(key, buf)
      return { bytesWritten: buf.length }
    },
    getStream: async (key) => (blobs.has(key) ? Readable.from(blobs.get(key) as Buffer) : null),
    put: async (key, bytes) => {
      blobs.set(key, bytes)
    },
    get: async (key) => blobs.get(key) ?? null,
    delete: async (key) => {
      blobs.delete(key)
    },
  }
}

// Minimal in-memory Prisma surface covering exactly what FileService touches,
// plus the organization row for the strip opt-out flag.
const makePrisma = (stripImageMetadata = true) => {
  const attachments = new Map<string, Record<string, unknown>>()
  const usage: { deltaBytes: bigint; operation: string }[] = []
  let seq = 0

  const client = {
    $executeRaw: async () => 0,
    organization: {
      findUnique: async () => ({ stripImageMetadata }),
    },
    attachment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1
        const row = {
          id: `att-${seq}`,
          width: null,
          height: null,
          messageId: null,
          knowledgePageId: null,
          // Prisma returns NULL for nullable columns the create omitted.
          thumbnailKey: null,
          thumbnailMime: null,
          thumbnailSizeBytes: null,
          thumbnailWidth: null,
          thumbnailHeight: null,
          thumbnailStatus: null,
          ...data,
        }
        attachments.set(row.id as string, row)
        return row
      },
      findUnique: async ({ where }: { where: { id: string } }) => attachments.get(where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        const row = attachments.get(where.id)
        attachments.delete(where.id)
        return row
      },
    },
    storageUsageEvent: {
      create: async ({ data }: { data: { deltaBytes: bigint; operation: string } }) => {
        usage.push(data)
        return data
      },
      aggregate: async () => ({
        _sum: { deltaBytes: usage.reduce((acc, row) => acc + row.deltaBytes, 0n) },
      }),
    },
    budget: {
      findMany: async () => [],
    },
    knowledgePage: {
      findUnique: async () => null,
    },
  }
  const prisma = {
    ...client,
    $transaction: async <T>(run: (tx: typeof client) => Promise<T>): Promise<T> => run(client),
  }
  return Object.assign(prisma as unknown as PrismaClient, { __usage: usage })
}

// Builds a minimal little-endian TIFF/EXIF block: IFD0 with Orientation=6
// (90° CW) and a GPS IFD holding a lat/long fix. sharp's withExif silently
// drops GPS tags, so the fixture splices this APP1 segment in by hand.
const tiffEntry = (tag: number, type: number, count: number, value: number | Buffer): Buffer => {
  const entry = Buffer.alloc(12)
  entry.writeUInt16LE(tag, 0)
  entry.writeUInt16LE(type, 2)
  entry.writeUInt32LE(count, 4)
  if (Buffer.isBuffer(value)) value.copy(entry, 8)
  else entry.writeUInt32LE(value, 8)
  return entry
}

const rationals = (pairs: [number, number][]): Buffer => {
  const data = Buffer.alloc(pairs.length * 8)
  pairs.forEach(([num, den], i) => {
    data.writeUInt32LE(num, i * 8)
    data.writeUInt32LE(den, i * 8 + 4)
  })
  return data
}

const GPS_IFD_OFFSET = 8 + 2 + 12 * 2 + 4 // header + IFD0 (2 entries)
const GPS_DATA_OFFSET = GPS_IFD_OFFSET + 2 + 12 * 5 + 4 // + GPS IFD (5 entries)

const makeExifSegment = (): Buffer => {
  const header = Buffer.alloc(8)
  header.write('II', 0, 'latin1')
  header.writeUInt16LE(0x2a, 2)
  header.writeUInt32LE(8, 4)
  const ifd0Count = Buffer.alloc(2)
  ifd0Count.writeUInt16LE(2, 0)
  const gpsIfdCount = Buffer.alloc(2)
  gpsIfdCount.writeUInt16LE(5, 0)
  const noNext = Buffer.alloc(4)
  const tiff = Buffer.concat([
    header,
    ifd0Count,
    tiffEntry(0x0112, 3, 1, 6), // Orientation = 6
    tiffEntry(0x8825, 4, 1, GPS_IFD_OFFSET), // GPSInfo pointer
    noNext,
    gpsIfdCount,
    tiffEntry(0x0000, 1, 4, Buffer.from([2, 3, 0, 0])), // GPSVersionID
    tiffEntry(0x0001, 2, 2, Buffer.from('N\0', 'latin1')),
    tiffEntry(0x0002, 5, 3, GPS_DATA_OFFSET), // GPSLatitude
    tiffEntry(0x0003, 2, 2, Buffer.from('E\0', 'latin1')),
    tiffEntry(0x0004, 5, 3, GPS_DATA_OFFSET + 24), // GPSLongitude
    noNext,
    rationals([
      [46, 1],
      [30, 1],
      [0, 1],
    ]),
    rationals([
      [6, 1],
      [30, 1],
      [0, 1],
    ]),
  ])
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([app1, payload])
}

// 100x50 JPEG with GPS EXIF and EXIF orientation 6 (a viewer that honors EXIF
// shows it as 50x100 portrait).
const makeExifJpeg = async (): Promise<Buffer> => {
  const base = await sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  const segment = makeExifSegment()
  return Buffer.concat([base.subarray(0, 2), segment, base.subarray(2)])
}

// GPS IFD pointer tag 0x8825, little-endian, as it appears in the EXIF blob.
const GPS_IFD_POINTER = Buffer.from([0x25, 0x88])

const storeOne = async (
  files: ReturnType<typeof createFileService>,
  mime: string,
  body: Buffer,
) =>
  files.store({
    attribution,
    organizationId: ORG,
    uploaderId: 'user-1',
    filename: 'upload.bin',
    mime,
    body: Readable.from(body),
  })

test('JPEG with GPS EXIF is stored stripped, orientation normalized, accounting post-strip', async () => {
  const fixture = await makeExifJpeg()
  const fixtureMeta = await sharp(fixture).metadata()
  assert.ok(fixtureMeta.exif && fixtureMeta.exif.includes(GPS_IFD_POINTER), 'fixture carries GPS')
  assert.equal(fixtureMeta.orientation, 6)

  const files = createFileService({
    prisma: makePrisma(),
    storage: makeStorage(),
    maxUploadBytes: 1_000_000,
  })
  const { attachment } = await storeOne(files, 'image/jpeg', fixture)
  const stored = await files
    .openStream(attachment.id, ORG)
    .then((opened) => collectStream((opened as { stream: Readable }).stream))

  // Metadata gone, orientation baked into the pixels (100x50 → 50x100).
  const storedMeta = await sharp(stored).metadata()
  assert.equal(storedMeta.exif, undefined)
  assert.equal(storedMeta.orientation, undefined)
  assert.equal(storedMeta.width, 50)
  assert.equal(storedMeta.height, 100)
  // Attachment row reflects the normalized dimensions.
  assert.equal(attachment.width, 50)
  assert.equal(attachment.height, 100)
  // Accounting records the post-strip byte size.
  assert.equal(attachment.sizeBytes, BigInt(stored.length))
  // Usage now sums the original plus its generated preview; both are stored
  // bytes and both are metered (see the thumbnail tests at the end).
  assert.equal(
    (await files.usageForScope({ organizationId: ORG })).toString(),
    String(stored.length + Number(attachment.thumbnailSizeBytes)),
  )
})

test('ICC color profile survives the strip', async () => {
  const base = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), ICC_PROFILE])
  const segment = Buffer.alloc(4)
  segment.writeUInt16BE(0xffe2, 0)
  segment.writeUInt16BE(payload.length + 2, 2)
  const fixture = Buffer.concat([base.subarray(0, 2), segment, payload, base.subarray(2)])
  assert.ok((await sharp(fixture).metadata()).icc, 'fixture carries an ICC profile')

  const files = createFileService({
    prisma: makePrisma(),
    storage: makeStorage(),
    maxUploadBytes: 1_000_000,
  })
  const { attachment } = await storeOne(files, 'image/jpeg', fixture)
  const stored = await files
    .openStream(attachment.id, ORG)
    .then((opened) => collectStream((opened as { stream: Readable }).stream))

  const storedMeta = await sharp(stored).metadata()
  assert.ok(storedMeta.icc, 'ICC profile preserved')
  assert.deepEqual(storedMeta.icc, ICC_PROFILE)
})

test('org opt-out flag stores image bytes untouched', async () => {
  const fixture = await makeExifJpeg()
  const files = createFileService({
    prisma: makePrisma(false),
    storage: makeStorage(),
    maxUploadBytes: 1_000_000,
  })
  const { attachment } = await storeOne(files, 'image/jpeg', fixture)
  const stored = await files
    .openStream(attachment.id, ORG)
    .then((opened) => collectStream((opened as { stream: Readable }).stream))
  assert.deepEqual(stored, fixture)
})

test('non-image uploads pass through byte-identical', async () => {
  const payload = Buffer.from('plain bytes, not an image')
  const files = createFileService({
    prisma: makePrisma(),
    storage: makeStorage(),
    maxUploadBytes: 1_000_000,
  })
  const { attachment } = await storeOne(files, 'application/pdf', payload)
  const stored = await files
    .openStream(attachment.id, ORG)
    .then((opened) => collectStream((opened as { stream: Readable }).stream))
  assert.deepEqual(stored, payload)
  assert.equal(attachment.sizeBytes, BigInt(payload.length))
})

test('undecodable image content passes through byte-identical', async () => {
  const garbage = Buffer.from('this is declared image/jpeg but is not one')
  const files = createFileService({
    prisma: makePrisma(),
    storage: makeStorage(),
    maxUploadBytes: 1_000_000,
  })
  const { attachment } = await storeOne(files, 'image/jpeg', garbage)
  const stored = await files
    .openStream(attachment.id, ORG)
    .then((opened) => collectStream((opened as { stream: Readable }).stream))
  assert.deepEqual(stored, garbage)
})

test('images above the strip threshold stream through unchanged', async () => {
  const oversized = IMAGE_STRIP_MAX_BYTES + 1024
  // Stream the oversized body in chunks (never one giant buffer) and collect
  // a checksum on the fly so the test itself does not hold two full copies.
  const { createHash, randomBytes } = await import('node:crypto')
  const chunk = randomBytes(64 * 1024)
  const expected = createHash('sha256')
  const body = (async function* () {
    let remaining = oversized
    while (remaining > 0) {
      const slice = chunk.subarray(0, Math.min(chunk.length, remaining))
      expected.update(slice)
      remaining -= slice.length
      yield slice
    }
  })()

  const prepared = await prepareImageUpload(Readable.from(body))
  const actual = createHash('sha256')
  for await (const part of prepared.body) {
    actual.update(part as Buffer)
  }
  assert.equal(prepared.width, null)
  assert.equal(actual.digest('hex'), expected.digest('hex'))
})

// ─── Thumbnails ────────────────────────────────────────────────────────────
// The preview is derived from the already-stripped buffer at the same
// chokepoint, so it is covered by the same fixtures.

test('an image upload stores a thumbnail alongside it, accounted separately', async () => {
  const fixture = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer()
  const prisma = makePrisma()
  const storage = makeStorage()
  const files = createFileService({ prisma, storage, maxUploadBytes: 10_000_000 })

  const { attachment } = await storeOne(files, 'image/jpeg', fixture)

  // Two objects: the original and `<key>.thumb.webp`.
  assert.equal(storage.blobs.size, 2)
  assert.equal(attachment.thumbnailKey, `${attachment.storageKey}.thumb.webp`)
  assert.equal(attachment.thumbnailMime, 'image/webp')
  assert.equal(attachment.thumbnailStatus, 'ready')
  // Fitted inside the 640px box, keeping the 3:2 ratio.
  assert.equal(attachment.thumbnailWidth, 640)
  assert.equal(attachment.thumbnailHeight, 427)

  const thumbBytes = storage.blobs.get(attachment.thumbnailKey as string) as Buffer
  assert.equal(attachment.thumbnailSizeBytes, BigInt(thumbBytes.length))
  assert.equal((await sharp(thumbBytes).metadata()).format, 'webp')
  // The whole point: a preview is a small fraction of the original.
  assert.ok(thumbBytes.length < Number(attachment.sizeBytes))

  // Served through its own stream, presenting the preview's identity.
  const opened = await files.openThumbnailStream(attachment.id, ORG)
  assert.ok(opened)
  assert.equal(opened.attachment.mime, 'image/webp')
  assert.equal(opened.attachment.sizeBytes, BigInt(thumbBytes.length))
  assert.deepEqual(await collectStream(opened.stream), thumbBytes)

  // Accounting: one +bytes event per object, and usage sums both.
  const usage = (prisma as unknown as { __usage: { deltaBytes: bigint; operation: string }[] })
    .__usage
  assert.deepEqual(
    usage.map((row) => row.operation),
    ['store', 'store.thumbnail'],
  )
  assert.equal(
    (await files.usageForScope({ organizationId: ORG })).toString(),
    String(Number(attachment.sizeBytes) + thumbBytes.length),
  )
})

test('deleting an attachment frees the thumbnail object and nets its bytes to zero', async () => {
  const fixture = await sharp({
    create: { width: 900, height: 900, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer()
  const prisma = makePrisma()
  const storage = makeStorage()
  const files = createFileService({ prisma, storage, maxUploadBytes: 10_000_000 })

  const { attachment } = await storeOne(files, 'image/png', fixture)
  assert.equal(storage.blobs.size, 2)

  assert.equal(await files.delete(attachment.id, ORG, attribution), true)

  // Neither object may survive — a leaked thumbnail is invisible storage.
  assert.equal(storage.blobs.size, 0)
  assert.equal((await files.usageForScope({ organizationId: ORG })).toString(), '0')
  const usage = (prisma as unknown as { __usage: { deltaBytes: bigint; operation: string }[] })
    .__usage
  assert.deepEqual(
    usage.map((row) => row.operation),
    ['store', 'store.thumbnail', 'delete', 'delete.thumbnail'],
  )
})

test('an animated WebP thumbnail keeps frame-0 geometry, not the filmstrip', async () => {
  // Three 60x40 frames. sharp decodes an animated image as a vertically
  // stacked filmstrip when `animated: true` (which the store pipeline uses),
  // so a naive thumbnail would come out 60x120 instead of 60x40.
  const frame = async (r: number, g: number, b: number): Promise<Buffer> =>
    sharp({ create: { width: 60, height: 40, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer()
  const animated = await sharp(
    [await frame(255, 0, 0), await frame(0, 255, 0), await frame(0, 0, 255)],
    { join: { animated: true } },
  )
    .webp({ loop: 0 })
    .toBuffer()
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 3, 'fixture animates')
  assert.equal((await sharp(animated, { animated: true }).metadata()).height, 120, 'filmstrip')

  const files = createFileService({
    prisma: makePrisma(),
    storage: makeStorage(),
    maxUploadBytes: 10_000_000,
  })
  const { attachment } = await storeOne(files, 'image/webp', animated)

  assert.equal(attachment.thumbnailWidth, 60)
  assert.equal(attachment.thumbnailHeight, 40)
})

test('an undecodable image still uploads — it just has no thumbnail', async () => {
  const garbage = Buffer.from('declared image/png, decodes as nothing')
  const storage = makeStorage()
  const files = createFileService({
    prisma: makePrisma(),
    storage,
    maxUploadBytes: 1_000_000,
  })
  const { attachment } = await storeOne(files, 'image/png', garbage)

  assert.equal(storage.blobs.size, 1)
  assert.equal(attachment.thumbnailKey, null)
  assert.equal(attachment.thumbnailStatus, null)
})
