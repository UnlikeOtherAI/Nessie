import assert from 'node:assert/strict'
import test from 'node:test'

import {
  lastLoadedNativeAvatar,
  loadNativeAvatar,
  nativeAvatarRefreshGeneration,
  requestNativeAvatarRefresh,
  resetNativeAvatarCache,
  subscribeNativeAvatarRefresh,
} from './native-avatar-source'

const URL = 'https://authentication.example/teams/design/avatar?size=128'

type Reply = { body: Uint8Array | string; etag?: string; status?: number; type?: string }

const fakeFetch = (replies: Reply[]) => {
  const sent: Record<string, string>[] = []
  const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
    sent.push(init.headers)
    const reply = replies.shift()
    assert.ok(reply, 'unexpected avatar request')
    const status = reply.status ?? 200
    const headers = new Headers({
      ...(reply.type ? { 'content-type': reply.type } : {}),
      ...(reply.etag ? { etag: reply.etag } : {}),
    })
    const bytes = typeof reply.body === 'string' ? new TextEncoder().encode(reply.body) : reply.body
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      headers,
      ok: status >= 200 && status < 300,
      status,
      text: async () => new TextDecoder().decode(bytes),
    }
  }
  return { fetchImpl, sent }
}

test('a replaced avatar at the same URL is reloaded, not served from cache', async () => {
  resetNativeAvatarCache()
  const { fetchImpl, sent } = fakeFetch([
    { body: new Uint8Array([1, 2, 3]), etag: '"old"', type: 'image/png' },
    { body: new Uint8Array([4, 5, 6]), etag: '"new"', type: 'image/png' },
  ])

  const first = await loadNativeAvatar(URL, { fetchImpl })
  assert.deepEqual(first, { kind: 'raster', uri: 'data:image/png;base64,AQID' })
  // The first request still carries If-None-Match: it is what makes React
  // Native's iOS networking bypass the stale local URL cache.
  assert.ok(sent[0]?.['If-None-Match'])
  assert.notEqual(sent[0]?.['If-None-Match'], '"old"')

  const second = await loadNativeAvatar(URL, { fetchImpl })
  assert.equal(sent[1]?.['If-None-Match'], '"old"')
  assert.deepEqual(second, { kind: 'raster', uri: 'data:image/png;base64,BAUG' })
  assert.deepEqual(lastLoadedNativeAvatar(URL), second)
})

test('an unchanged avatar answers 304 and keeps the picture already loaded', async () => {
  resetNativeAvatarCache()
  const { fetchImpl } = fakeFetch([
    { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', etag: '"svg"', type: 'image/svg+xml' },
    { body: '', status: 304 },
  ])

  const first = await loadNativeAvatar(URL, { fetchImpl })
  assert.equal(first.kind, 'svg')
  assert.deepEqual(await loadNativeAvatar(URL, { fetchImpl }), first)
})

test('a failed or empty response rejects so the caller can keep its picture', async () => {
  resetNativeAvatarCache()
  const { fetchImpl } = fakeFetch([
    { body: '', status: 304 },
    { body: '', status: 500 },
    { body: new Uint8Array(), type: 'image/png' },
  ])
  await assert.rejects(loadNativeAvatar(URL, { fetchImpl }))
  await assert.rejects(loadNativeAvatar(URL, { fetchImpl }))
  await assert.rejects(loadNativeAvatar(URL, { fetchImpl }))
  assert.equal(lastLoadedNativeAvatar(URL), null)
})

test('a refresh request notifies subscribers and advances the generation', () => {
  let calls = 0
  const before = nativeAvatarRefreshGeneration()
  const unsubscribe = subscribeNativeAvatarRefresh(() => {
    calls += 1
  })
  requestNativeAvatarRefresh()
  unsubscribe()
  requestNativeAvatarRefresh()
  assert.equal(calls, 1)
  assert.equal(nativeAvatarRefreshGeneration(), before + 2)
})
