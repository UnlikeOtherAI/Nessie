import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'

import { SourceAssetTooLargeError, SourceAuthError } from '../src/errors.js'
import {
  SOURCE_ASSET_LIMIT_BYTES,
  SourceHttpError,
  inlineAssetUrls,
  limitAssetStream,
  sourceFetchStream,
  streamFromSourceResponse,
} from '../src/index.js'

const MIB = 1024 * 1024

/** Drain a stream into a counter, the way the file store reads one. */
const drain = async (stream: Readable): Promise<number> => {
  let total = 0
  await pipeline(
    stream,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        total += chunk.byteLength
        callback()
      },
    }),
  )
  return total
}

/** A body of `size` bytes in 1 MiB chunks, with no declared length. */
const chunked = (size: number): ReadableStream<Uint8Array> => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close()
        return
      }
      const next = Math.min(MIB, size - sent)
      sent += next
      controller.enqueue(new Uint8Array(next))
    },
  })
}

test('the asset cap is 25 MiB, the upload route’s own number', () => {
  assert.equal(SOURCE_ASSET_LIMIT_BYTES, 25 * MIB)
})

test('a 26 MiB file with a declared length is refused before a byte is read', async () => {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      controller.enqueue(new Uint8Array(MIB))
    },
  })
  const response = new Response(body, {
    status: 200,
    headers: { 'content-length': String(26 * MIB), 'content-type': 'image/png' },
  })
  await assert.rejects(streamFromSourceResponse(response), SourceAssetTooLargeError)
  // At most the stream's own high-water pre-read; never the file.
  assert.ok(pulled <= 1, `read ${pulled} chunks of a refused file`)
})

test('a 26 MiB file with no declared length is cut off as it passes the cap', async () => {
  const response = new Response(chunked(26 * MIB), { status: 200 })
  const asset = await streamFromSourceResponse(response)
  assert.equal(asset.sizeBytes, null)
  await assert.rejects(drain(asset.stream), SourceAssetTooLargeError)
})

test('a file under the cap streams through whole, with its type', async () => {
  const response = new Response(chunked(3 * MIB + 17), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
  const asset = await streamFromSourceResponse(response)
  assert.equal(asset.contentType, 'image/png')
  assert.equal(await drain(asset.stream), 3 * MIB + 17)
})

test('the counting transform holds for any source, not just a fetch body', async () => {
  await assert.rejects(drain(limitAssetStream(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15)), SourceAssetTooLargeError)
  assert.equal(await drain(limitAssetStream(Readable.from([Buffer.alloc(10)]), 15)), 10)
})

test('provider refusals are classified like every other source call', async () => {
  await assert.rejects(
    streamFromSourceResponse(new Response('nope', { status: 404 })),
    (error: unknown) => error instanceof SourceHttpError && error.status === 404,
  )
  await assert.rejects(streamFromSourceResponse(new Response('no', { status: 403 })), SourceAuthError)
})

test('an asset host the adapter did not declare is refused before any request', async () => {
  await assert.rejects(
    sourceFetchStream({ url: 'https://evil.test/a.png', allowedHosts: ['uploads.linear.app'] }),
    /is not an allowed host/,
  )
})

test('inline asset URLs are only the adapter’s own hosts, over https, once each', () => {
  const markdown = [
    '![a](https://uploads.linear.app/x/a.png)',
    '[file](https://uploads.linear.app/x/b.pdf "title")',
    '![again](https://uploads.linear.app/x/a.png)',
    '![remote](https://example.com/c.png)',
    '![plain](http://uploads.linear.app/x/d.png)',
  ].join('\n')
  assert.deepEqual(inlineAssetUrls(markdown, ['uploads.linear.app']), [
    'https://uploads.linear.app/x/a.png',
    'https://uploads.linear.app/x/b.pdf',
  ])
  assert.deepEqual(inlineAssetUrls(null, ['uploads.linear.app']), [])
})
