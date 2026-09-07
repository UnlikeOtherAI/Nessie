import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { Attachment, PrismaClient } from '@prisma/client'

import { createFileService } from '../src/files/index.js'
import {
  attachmentDisposition,
  resolveAttachmentDownload,
  SIGNED_DOWNLOAD_EXPIRY_SECONDS,
} from '../src/files/download.js'
import type { SignedDownloadRequest, Storage } from '../src/storage/index.js'

/**
 * Plan row 5.7 / audit 6.4: every download used to be proxied, so a multi-GiB
 * transfer lived and died with one API process. Past a threshold the bytes now
 * come from the object store directly.
 *
 * What is under test here is the FileService's half of that — which route a
 * given attachment takes, and what the signature is allowed to fetch. The
 * route's half (the 302 itself, its headers, and the fact that authorisation
 * runs first) is in api/test/attachment-signed-download.test.ts.
 */

const organizationId = '00000000-0000-4000-8000-00000000d001'
const otherOrganizationId = '00000000-0000-4000-8000-00000000d002'

const attachmentRow = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: '00000000-0000-4000-8000-00000000dd01',
  organizationId,
  uploaderId: null,
  messageId: null,
  knowledgePageId: null,
  emailMessageId: null,
  kind: 'file',
  mime: 'application/zip',
  filename: 'archive.zip',
  sizeBytes: 64n,
  storageKey: `${organizationId}/object`,
  width: null,
  height: null,
  thumbnailKey: null,
  thumbnailMime: null,
  thumbnailSizeBytes: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  thumbnailStatus: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
} as Attachment)

type Recorder = {
  signed: Array<SignedDownloadRequest & { key: string }>
  streamed: string[]
}

const fakeStorage = (
  mode: 'signs' | 'throws' | 'cannot-sign',
): Storage & Recorder => {
  const signed: Recorder['signed'] = []
  const streamed: string[] = []
  const base: Storage & Recorder = {
    delete: async () => undefined,
    get: async () => null,
    getStream: async (key) => {
      streamed.push(key)
      return Readable.from(Buffer.from('bytes'))
    },
    put: async () => undefined,
    putStream: async () => ({ bytesWritten: 0 }),
    signed,
    streamed,
  }
  if (mode === 'cannot-sign') return base
  return {
    ...base,
    signedDownloadUrl: async (key, request) => {
      signed.push({ ...request, key })
      if (mode === 'throws') throw new Error('signer unavailable')
      return `https://objects.example/${key}?X-Amz-Signature=deadbeef`
    },
  }
}

test('an object at or past the threshold is answered with a signed URL', async () => {
  const storage = fakeStorage('signs')

  const download = await resolveAttachmentDownload(
    storage,
    attachmentRow({ sizeBytes: 1024n }),
    { minBytes: 1024 },
  )

  assert.equal(download?.kind, 'redirect')
  assert.equal(storage.streamed.length, 0, 'the API must not open the object')
  assert.equal(storage.signed.length, 1)
})

test('an object under the threshold is still proxied', async () => {
  const storage = fakeStorage('signs')

  const download = await resolveAttachmentDownload(
    storage,
    attachmentRow({ sizeBytes: 1023n }),
    { minBytes: 1024 },
  )

  assert.equal(download?.kind, 'stream')
  assert.equal(storage.signed.length, 0)
  assert.deepEqual(storage.streamed, [`${organizationId}/object`])
})

test('the signature pins the type, the filename and a short expiry', async () => {
  const storage = fakeStorage('signs')

  await resolveAttachmentDownload(
    storage,
    attachmentRow({ filename: 'photo.png', mime: 'image/png', sizeBytes: 4096n }),
    { minBytes: 1024 },
  )

  assert.deepEqual(storage.signed[0], {
    disposition: 'inline',
    expiresInSeconds: SIGNED_DOWNLOAD_EXPIRY_SECONDS,
    filename: 'photo.png',
    key: `${organizationId}/object`,
    mime: 'image/png',
  })
  // The window is the handover, not the transfer: a store checks the signature
  // when the GET arrives and then streams for as long as the bytes take.
  assert.ok(SIGNED_DOWNLOAD_EXPIRY_SECONDS <= 300)
  // The two routes must answer with the same disposition, or the route's
  // contract would change with the file's size.
  assert.equal(storage.signed[0]?.disposition, attachmentDisposition('image/png'))
})

test('a backend that cannot sign proxies instead of failing', async () => {
  const storage = fakeStorage('cannot-sign')

  const download = await resolveAttachmentDownload(
    storage,
    attachmentRow({ sizeBytes: 5n * 1024n * 1024n * 1024n }),
    { minBytes: 1024 },
  )

  assert.equal(download?.kind, 'stream')
})

test('a signer that throws proxies instead of failing', async () => {
  const storage = fakeStorage('throws')

  const download = await resolveAttachmentDownload(
    storage,
    attachmentRow({ sizeBytes: 4096n }),
    { minBytes: 1024 },
  )

  assert.equal(download?.kind, 'stream')
  assert.equal(storage.signed.length, 1, 'it tried')
  assert.deepEqual(storage.streamed, [`${organizationId}/object`], 'and then proxied')
})

test('no URL is minted for an attachment belonging to another organisation', async () => {
  const storage = fakeStorage('signs')
  const row = attachmentRow({ sizeBytes: 4096n })
  const prisma = {
    attachment: { findUnique: async () => row },
  } as unknown as PrismaClient
  const files = createFileService({
    maxUploadBytes: 5_000_000,
    prisma,
    signedDownloadMinBytes: 1024,
    storage,
  })

  // The row exists and is well past the threshold; the only thing wrong is the
  // tenant asking for it. A signed URL is a bearer capability, so the refusal
  // has to happen before minting, not after.
  const download = await files.openDownload(row.id, otherOrganizationId)

  assert.equal(download, null)
  assert.equal(storage.signed.length, 0)
  assert.equal(storage.streamed.length, 0)
})
