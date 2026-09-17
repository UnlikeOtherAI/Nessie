import assert from 'node:assert/strict'
import test from 'node:test'

import { formatLocalMcp } from '../src/run/pa-tools/executors.js'

/**
 * What a Personal Assistant answers when asked "is Kelpie available on my Mac,
 * and what can it see". Three states must survive the summary because they
 * lead a person to different actions, and a few lines of prose is exactly
 * where distinctions like these get flattened.
 */

const device = (over: Record<string, unknown> = {}) => ({
  address: '192.168.1.42',
  id: 'kelpie-ios-9f2a',
  lastSeenAt: '2026-09-17T09:59:58.000Z',
  name: "Ondrej's iPhone",
  paired: true,
  platform: 'ios' as const,
  port: 51_873,
  version: '0.1.3',
  ...over,
})

test('a daemon that has never reported says so, rather than reading as empty', () => {
  const answer = formatLocalMcp(undefined, undefined)
  assert.match(answer, /never reported/)
  assert.ok(!answer.includes('names no local MCP server'))
})

test('a daemon that reports and names nothing is a different answer', () => {
  const answer = formatLocalMcp([], undefined)
  assert.match(answer, /names no local MCP server/)
  assert.ok(!answer.includes('never reported'))
})

test('an unavailable server carries the reason a person acts on', () => {
  const answer = formatLocalMcp([{
    available: false,
    observedAt: '2026-09-17T10:00:00.000Z',
    reason: 'not_installed',
    server: 'kelpie',
  }], '2026-09-17T10:00:00.000Z')
  assert.match(answer, /kelpie=unavailable reason=not_installed/)
})

test('an available Kelpie states its instances by what Kelpie advertises', () => {
  const answer = formatLocalMcp([{
    available: true,
    catalogDigest: `sha256:${'a'.repeat(64)}`,
    kelpieDevices: [device()],
    observedAt: '2026-09-17T10:00:00.000Z',
    server: 'kelpie',
    serverVersion: '0.1.11',
    toolCount: 145,
  }], '2026-09-17T10:00:00.000Z')

  assert.match(answer, /kelpie=available version=0\.1\.11 tools=145/)
  assert.match(answer, /Ondrej's iPhone/)
  assert.match(answer, /192\.168\.1\.42:51873/)
  // The age must travel: the inventory is last-observed, never live.
  assert.match(answer, /observed 2026-09-17T10:00:00\.000Z/)
  assert.match(answer, /last seen 2026-09-17T09:59:58\.000Z/)
})

test('an unpaired instance says a person must pair on the device', () => {
  // Kelpie refuses automation until somebody pairs there, so an answer that
  // read "available" without this would offer a capability that then fails.
  const answer = formatLocalMcp([{
    available: true,
    kelpieDevices: [device({ paired: false })],
    observedAt: '2026-09-17T10:00:00.000Z',
    server: 'kelpie',
  }], '2026-09-17T10:00:00.000Z')
  assert.match(answer, /NOT paired — a person must pair on the device/)
})

test('an installed Kelpie that found nothing differs from one never probed', () => {
  const found = formatLocalMcp([{
    available: true, kelpieDevices: [], observedAt: 'x', server: 'kelpie',
  }], 'x')
  const unprobed = formatLocalMcp([{
    available: true, observedAt: 'x', server: 'kelpie',
  }], 'x')

  assert.match(found, /none announced on that network/)
  assert.ok(!unprobed.includes('none announced'), 'never probed is not an empty network')
})

test('a long instance list is bounded rather than filling the answer', () => {
  const answer = formatLocalMcp([{
    available: true,
    kelpieDevices: Array.from({ length: 20 }, (_, index) => device({ id: `k-${index}` })),
    observedAt: 'x',
    server: 'kelpie',
  }], 'x')
  assert.match(answer, /…and 12 more/)
})
