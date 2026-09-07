// What the client does with a truncated replay (horizontal-scaling audit 2.9).
//
// The server caps how many events one replay may carry and now says so, with a
// `realtime.gap` frame at the end of a replay it had to cut short. A marker
// nothing acts on is not a fix, so this pins all three halves of the answer:
// the name the client watches for is the name the server writes, the frame
// really does trigger a REST bootstrap (against a real query client, not a
// spy), and the recovery is actually mounted in the shell.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { QueryClient } from '@tanstack/react-query'

import type { SseFrame } from '../src/lib/sse.js'
import {
  createRealtimeGapBootstrap,
  handleRealtimeGapFrame,
  isRealtimeGapFrame,
  REALTIME_GAP_EVENT,
} from '../src/facades/realtime/realtime-gap.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const frame = (event: string): SseFrame => ({ data: '{}', event, id: '' })

test('the client watches for the event name the API actually writes', () => {
  // Two files, one wire contract. A rename on either side turns the gap signal
  // back into the silent truncation it replaced, and nothing else would notice.
  const api = readSource('../../api/src/realtime/notification-delivery.ts')

  assert.match(
    api,
    new RegExp(`REALTIME_GAP_EVENT = '${REALTIME_GAP_EVENT}'`),
    'the admin and the API must agree on the gap event name',
  )
  assert.match(
    api,
    /formatRealtimeGapEvent = \(\) =>\s*`event: \$\{REALTIME_GAP_EVENT\}/,
    'and the frame must be written under that name',
  )
})

test('a gap frame triggers the bootstrap and nothing else does', () => {
  const bootstraps: number[] = []
  const bootstrap = () => bootstraps.push(1)

  assert.equal(handleRealtimeGapFrame(frame(REALTIME_GAP_EVENT), bootstrap), true)
  assert.equal(bootstraps.length, 1, 'a gap frame must be acted on')

  for (const other of ['alert.created', 'message.new', 'thread.read', '']) {
    assert.equal(handleRealtimeGapFrame(frame(other), bootstrap), false)
  }
  assert.equal(bootstraps.length, 1, 'an ordinary event must not bootstrap anything')
  assert.equal(isRealtimeGapFrame(frame('alert.created')), false)
})

test('the bootstrap really invalidates the cached REST reads, not a filtered slice', async () => {
  // A real QueryClient: the assertion is what React Query ends up believing
  // about the cache, not that some method was called.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
  })
  const keys = [['alerts', 'summary'], ['threads', 'activity'], ['channels', 'list']]
  for (const key of keys) {
    queryClient.setQueryData(key, { seeded: true })
  }
  for (const key of keys) {
    assert.equal(
      queryClient.getQueryState(key)?.isInvalidated,
      false,
      'a freshly seeded query starts valid, or this test proves nothing',
    )
  }

  handleRealtimeGapFrame(frame(REALTIME_GAP_EVENT), createRealtimeGapBootstrap(queryClient))
  // `invalidateQueries` marks synchronously and refetches active queries after;
  // none of these are mounted, so the mark is the whole observable effect.
  await Promise.resolve()

  for (const key of keys) {
    assert.equal(
      queryClient.getQueryState(key)?.isInvalidated,
      true,
      `${JSON.stringify(key)} must be re-read: a truncated replay says nothing about which surface the withheld events touched`,
    )
  }
})

test('the recovery is mounted once, in the shell', () => {
  // Rule zero: a capability nobody reaches is unfinished, and a gap handler
  // that is never mounted is exactly that.
  const shell = readSource('../src/layouts/AdminShellLayout.tsx')

  assert.match(shell, /useRealtimeGapRecovery\(\);/, 'the shell must mount the gap recovery')
  assert.equal(
    shell.match(/useRealtimeGapRecovery\(\);/g)?.length,
    1,
    'exactly once — one gap must not cost one full cache refetch per subscriber',
  )
})
