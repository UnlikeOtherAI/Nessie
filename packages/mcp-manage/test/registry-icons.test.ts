import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoreFileInput } from '@nessie/runtime'

import {
  cacheRegistryIcon,
  parseAdvertisedIcons,
  pickIconCandidate,
  REGISTRY_ICON_SOURCE,
  sniffImageMime,
  type IconFetch,
  type IconFileService,
  type RegistryIcon,
} from '../src/registry/registry-icons.js'

/**
 * Icon caching treats a registry icon as untrusted external content, so the
 * cases that matter are the refusals: an SVG never fetched, bytes that lie about
 * their type rejected after fetch, an oversize stream aborted mid-transfer, and
 * every network error swallowed to null. The fetch and the FileService are both
 * injected, so none of this touches the network or a database.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 0x11)])

// A minimal Response over the three fields cacheRegistryIcon reads. Built by
// hand rather than via `new Response(stream)` so the stream's own cancel()
// fires deterministically when the cap is crossed — undici's Response can tee.
const responseOf = (
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
  ok = true,
): Response =>
  ({
    ok,
    body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  }) as unknown as Response

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index]!)
      index += 1
    },
  })
}

const recordingFileService = () => {
  const calls: StoreFileInput[] = []
  const service: IconFileService = {
    store: async (input: StoreFileInput) => {
      calls.push(input)
      return { attachment: { id: `att-${calls.length}` } }
    },
  }
  return { calls, service }
}

const countingFetch = (impl: IconFetch) => {
  let count = 0
  const fetchIcon: IconFetch = async (url, init) => {
    count += 1
    return impl(url, init)
  }
  return { fetchIcon, count: () => count }
}

const pngIcon: RegistryIcon = {
  src: 'https://example.com/icon.png',
  mimeType: 'image/png',
  sizes: '128x128',
}

test('a PNG is fetched, sniffed, and cached through the FileService', async () => {
  const { calls, service } = recordingFileService()
  const { fetchIcon } = countingFetch(async () =>
    responseOf(streamOf(new Uint8Array(pngBytes))))

  const result = await cacheRegistryIcon({
    icons: [pngIcon],
    fetchIcon,
    fileService: service,
    organizationId: 'org-1',
    actorId: 'actor-1',
    displayName: 'GitHub',
  })

  assert.deepEqual(result, { attachmentId: 'att-1', source: REGISTRY_ICON_SOURCE })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.mime, 'image/png')
  assert.equal(calls[0]?.organizationId, 'org-1')
})

test('an SVG icon is refused without a fetch', async () => {
  const { calls, service } = recordingFileService()
  // Would succeed if it were ever called — proving the refusal is structural.
  const { fetchIcon, count } = countingFetch(async () =>
    responseOf(streamOf(new Uint8Array(pngBytes))))

  const result = await cacheRegistryIcon({
    icons: [{ src: 'https://example.com/logo.svg', mimeType: 'image/svg+xml', sizes: 'any' }],
    fetchIcon,
    fileService: service,
    organizationId: 'org-1',
    actorId: 'actor-1',
    displayName: 'Vector',
  })

  assert.equal(result, null)
  assert.equal(count(), 0)
  assert.equal(calls.length, 0)
})

test('bytes that do not match the claimed type are rejected', async () => {
  const { calls, service } = recordingFileService()
  // Advertised image/png, but the bytes are an SVG document.
  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const { fetchIcon } = countingFetch(async () =>
    responseOf(streamOf(new Uint8Array(svgBytes))))

  const result = await cacheRegistryIcon({
    icons: [pngIcon],
    fetchIcon,
    fileService: service,
    organizationId: 'org-1',
    actorId: 'actor-1',
    displayName: 'Liar',
  })

  assert.equal(result, null)
  assert.equal(calls.length, 0)
})

test('an over-cap stream is aborted mid-transfer and never stored', async () => {
  const { calls, service } = recordingFileService()
  let cancelled = false
  let pulls = 0
  const chunk = new Uint8Array(256 * 1024) // 256 KiB; cap is 512 KiB
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(chunk))
    },
    cancel() {
      cancelled = true
    },
  })
  const { fetchIcon } = countingFetch(async () => responseOf(stream))

  const result = await cacheRegistryIcon({
    icons: [pngIcon],
    fetchIcon,
    fileService: service,
    organizationId: 'org-1',
    actorId: 'actor-1',
    displayName: 'Huge',
  })

  assert.equal(result, null)
  assert.equal(calls.length, 0)
  assert.equal(cancelled, true)
  // Stopped early rather than draining an unbounded stream.
  assert.ok(pulls <= 4, `expected an early stop, saw ${pulls} pulls`)
})

test('a fetch error yields null and never throws', async () => {
  const { calls, service } = recordingFileService()
  const { fetchIcon } = countingFetch(async () => {
    throw new Error('connection reset')
  })

  const result = await cacheRegistryIcon({
    icons: [pngIcon],
    fetchIcon,
    fileService: service,
    organizationId: 'org-1',
    actorId: 'actor-1',
    displayName: 'Broken',
  })

  assert.equal(result, null)
  assert.equal(calls.length, 0)
})

test('no advertised icon means nothing to cache', async () => {
  const { calls, service } = recordingFileService()
  const { fetchIcon, count } = countingFetch(async () =>
    responseOf(streamOf(new Uint8Array(pngBytes))))

  const result = await cacheRegistryIcon({
    icons: [],
    fetchIcon,
    fileService: service,
    organizationId: 'org-1',
    actorId: 'actor-1',
    displayName: 'Empty',
  })

  assert.equal(result, null)
  assert.equal(count(), 0)
  assert.equal(calls.length, 0)
})

test('sniffImageMime reads magic bytes, not the label', () => {
  assert.equal(sniffImageMime(pngBytes), 'image/png')
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
  ])
  assert.equal(sniffImageMime(webp), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('<svg></svg>')), null)
})

test('parseAdvertisedIcons reads server.icons and tolerates anything else', () => {
  const icons = parseAdvertisedIcons({
    server: {
      icons: [
        { src: 'https://a/i.png', mimeType: 'image/png', sizes: '48x48' },
        { src: 'https://a/i.webp', sizes: ['96x96', '256x256'] },
      ],
    },
  })
  assert.equal(icons.length, 2)
  assert.equal(icons[1]?.sizes, '96x96 256x256')
  assert.deepEqual(parseAdvertisedIcons(null), [])
  assert.deepEqual(parseAdvertisedIcons({ server: {} }), [])
})

test('pickIconCandidate drops vectors and prefers a card-sized raster', () => {
  const chosen = pickIconCandidate([
    { src: 'https://a/logo.svg', mimeType: 'image/svg+xml', sizes: '512x512' },
    { src: 'https://a/tiny.png', mimeType: 'image/png', sizes: '16x16' },
    { src: 'https://a/good.png', mimeType: 'image/png', sizes: '128x128' },
  ])
  assert.equal(chosen, 'https://a/good.png')

  assert.equal(
    pickIconCandidate([{ src: 'data:image/png;base64,AAAA', mimeType: 'image/png', sizes: null }]),
    null,
  )
  assert.equal(pickIconCandidate([]), null)
})
