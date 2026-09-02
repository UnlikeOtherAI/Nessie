import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BLOB_CACHE_CAPACITY,
  blobCacheKey,
  blobCacheSize,
  clearBlobCache,
  peekBlobUrl,
  releaseBlobUrl,
  retainBlobUrl,
  setBlobCacheRevoke,
  storeBlobUrl,
} from '../src/lib/blob-cache.js'

// Step 10 of docs/done/2026-09-01-navigation-motion-system.md (§4.10),
// docs/navigation/overview.md §"Arriving with content".
//
// A `blob:` URL is a document-lifetime resource: dropping the last reference
// without revoking leaks the bytes for the life of the tab, and revoking one an
// <img> still points at renders as a broken image. So the cache revokes only on
// eviction, and only what nobody holds.

const withRevokeLog = (body: (revoked: string[]) => void): void => {
  const revoked: string[] = []
  const previous = setBlobCacheRevoke((url) => revoked.push(url))
  try {
    clearBlobCache()
    body(revoked)
  } finally {
    clearBlobCache()
    setBlobCacheRevoke(previous)
  }
}

test('a miss becomes a hit, and the hit is the same URL', () => {
  withRevokeLog(() => {
    const key = blobCacheKey('/api/attachments/att-1')
    assert.equal(retainBlobUrl(key), null, 'nothing cached yet')

    assert.equal(storeBlobUrl(key, 'blob:one'), 'blob:one')
    assert.equal(peekBlobUrl(key), 'blob:one', 'readable before the effect retains it')
    assert.equal(retainBlobUrl(key), 'blob:one', 'a second mount reuses the bytes')
  })
})

test('the pinned MIME is part of identity — the same path re-typed is a different blob', () => {
  assert.notEqual(
    blobCacheKey('/api/attachments/att-1'),
    blobCacheKey('/api/attachments/att-1', 'application/pdf'),
  )
})

test('a second writer for one key keeps the cached URL and revokes the loser', () => {
  withRevokeLog((revoked) => {
    const key = blobCacheKey('/api/attachments/att-2')
    storeBlobUrl(key, 'blob:first')
    assert.equal(storeBlobUrl(key, 'blob:second'), 'blob:first', 'the DOM sees one URL per key')
    assert.deepEqual(revoked, ['blob:second'])
  })
})

test('eviction revokes, and only what nobody is holding', () => {
  withRevokeLog((revoked) => {
    // Fill to capacity, releasing each so every entry is evictable.
    for (let index = 0; index < BLOB_CACHE_CAPACITY; index += 1) {
      const key = blobCacheKey(`/api/attachments/att-${index}`)
      storeBlobUrl(key, `blob:${index}`)
      releaseBlobUrl(key)
    }
    assert.equal(blobCacheSize(), BLOB_CACHE_CAPACITY)
    assert.deepEqual(revoked, [], 'nothing is revoked while under capacity')

    // A hit refreshes recency, so entry 0 is no longer the oldest.
    assert.equal(retainBlobUrl(blobCacheKey('/api/attachments/att-0')), 'blob:0')
    releaseBlobUrl(blobCacheKey('/api/attachments/att-0'))

    storeBlobUrl(blobCacheKey('/api/attachments/overflow'), 'blob:overflow')
    assert.deepEqual(revoked, ['blob:1'], 'the least recently used entry goes')
    assert.equal(peekBlobUrl(blobCacheKey('/api/attachments/att-1')), null)
    assert.equal(peekBlobUrl(blobCacheKey('/api/attachments/att-0')), 'blob:0')
    assert.equal(blobCacheSize(), BLOB_CACHE_CAPACITY)
  })
})

test('an entry a mounted component still points at is skipped, never revoked', () => {
  withRevokeLog((revoked) => {
    // One held entry (the reference from `storeBlobUrl` is never released),
    // then a full cache of releasable ones on top of it.
    const held = blobCacheKey('/api/attachments/held')
    storeBlobUrl(held, 'blob:held')
    for (let index = 0; index < BLOB_CACHE_CAPACITY; index += 1) {
      const key = blobCacheKey(`/api/attachments/spare-${index}`)
      storeBlobUrl(key, `blob:spare-${index}`)
      releaseBlobUrl(key)
    }

    assert.ok(!revoked.includes('blob:held'), 'a referenced URL is never revoked')
    assert.equal(peekBlobUrl(held), 'blob:held', 'and it is still readable')
    assert.deepEqual(revoked, ['blob:spare-0'])
  })
})

test('clearing revokes everything — the bytes belonged to the session that ended', () => {
  withRevokeLog((revoked) => {
    storeBlobUrl(blobCacheKey('/api/attachments/a'), 'blob:a')
    storeBlobUrl(blobCacheKey('/api/attachments/b'), 'blob:b')
    clearBlobCache()
    assert.deepEqual(revoked.sort(), ['blob:a', 'blob:b'])
    assert.equal(blobCacheSize(), 0)
    assert.equal(peekBlobUrl(blobCacheKey('/api/attachments/a')), null)
  })
})
