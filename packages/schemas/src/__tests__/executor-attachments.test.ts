import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH,
  EXECUTOR_RESULT_IMAGE_MAX_BYTES,
  ExecutorDaemonCommandAttachmentRequestSchema,
  ExecutorImageReferenceSchema,
  executorImageAttachmentMarker,
  executorImageUnavailableText,
  sniffExecutorImageMimeType,
} from '../index.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')

test('an image type is read from the bytes, never taken from a claim', () => {
  assert.equal(sniffExecutorImageMimeType(png), 'image/png')
  assert.equal(sniffExecutorImageMimeType(jpeg), 'image/jpeg')
  assert.equal(sniffExecutorImageMimeType(webp), 'image/webp')
  assert.equal(sniffExecutorImageMimeType(gif), 'image/gif')
  assert.equal(sniffExecutorImageMimeType(Buffer.from('GIF87a', 'latin1')), 'image/gif')
  // SVG, HTML and a truncated PNG signature are none of the four.
  assert.equal(sniffExecutorImageMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffExecutorImageMimeType(Buffer.from('<!doctype html>')), null)
  assert.equal(sniffExecutorImageMimeType(png.subarray(0, 7)), null)
  assert.equal(sniffExecutorImageMimeType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])), null)
  assert.equal(sniffExecutorImageMimeType(new Uint8Array()), null)
})

test('a reference names the bytes by digest and size and carries none of them', () => {
  const reference = {
    attachmentDigest: `sha256:${'a'.repeat(64)}`,
    byteLength: 13_715,
    mimeType: 'image/png',
    type: 'image',
  }
  assert.equal(ExecutorImageReferenceSchema.safeParse(reference).success, true)
  assert.equal(ExecutorImageReferenceSchema.safeParse({ ...reference, data: 'iVBOR' }).success, false)
  assert.equal(ExecutorImageReferenceSchema.safeParse({ ...reference, mimeType: 'image/svg+xml' }).success, false)
  assert.equal(
    ExecutorImageReferenceSchema.safeParse({ ...reference, byteLength: EXECUTOR_RESULT_IMAGE_MAX_BYTES + 1 }).success,
    false,
  )
  assert.equal(executorImageAttachmentMarker(reference.attachmentDigest), `[image: attachment sha256:${'a'.repeat(64)}]`)
  assert.equal(executorImageUnavailableText('it was refused'), '[image unavailable: it was refused]')
})

const requestFor = (bytes: Buffer, overrides: Record<string, unknown> = {}) => ({
  attachment: {
    byteLength: bytes.length,
    commandId: '00000000-0000-4000-8000-000000000503',
    digest: `sha256:${'b'.repeat(64)}`,
    mimeType: 'image/png',
    occurredAt: '2026-09-23T10:00:00.000Z',
  },
  connectionEpoch: '7',
  dataBase64: bytes.toString('base64'),
  executorId: '00000000-0000-4000-8000-000000000501',
  signature: 's'.repeat(86),
  ...overrides,
})

test('an upload carries padded base64 of exactly the bytes it signed a length for', () => {
  for (const length of [1, 2, 3, 4, 13_715]) {
    const bytes = Buffer.alloc(length, 9)
    assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse(requestFor(bytes)).success, true, `length ${length}`)
  }
  const bytes = Buffer.alloc(100, 9)
  const request = requestFor(bytes)
  // One byte more or less than signed.
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse({
    ...request, attachment: { ...request.attachment, byteLength: 101 },
  }).success, false)
  // Unpadded, base64url, and a field the contract does not name.
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse({
    ...request, dataBase64: request.dataBase64.replace(/=+$/, ''),
  }).success, false)
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse(
    requestFor(Buffer.from([0xfb, 0xff, 0xbf]), { dataBase64: '-_-_' }),
  ).success, false)
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse({ ...request, runId: 'x' }).success, false)
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse({
    ...request, attachment: { ...request.attachment, mimeType: 'image/svg+xml' },
  }).success, false)
})

test('an upload over the one-image cap is refused by its shape', () => {
  assert.equal(EXECUTOR_RESULT_IMAGE_MAX_BASE64_LENGTH, Buffer.alloc(EXECUTOR_RESULT_IMAGE_MAX_BYTES).toString('base64').length)
  const largest = Buffer.alloc(EXECUTOR_RESULT_IMAGE_MAX_BYTES, 1)
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse(requestFor(largest)).success, true)
  const over = Buffer.alloc(EXECUTOR_RESULT_IMAGE_MAX_BYTES + 3, 1)
  assert.equal(ExecutorDaemonCommandAttachmentRequestSchema.safeParse(requestFor(over)).success, false)
})
