import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { ApiClient, ThreadMessageRecord } from '../src/lib/api-client.js'
import {
  fetchThreadMessages,
  flattenThreadMessagePages,
  threadMessagesInfiniteQueryOptions,
  upsertNewestThreadMessage,
  type ThreadMessagePage,
  type ThreadMessagePages,
} from '../src/facades/threads/queries.js'
import { threadKeys } from '../src/facades/threads/keys.js'

const message = (
  id: string,
  createdAt: string,
  content = id,
): ThreadMessageRecord => ({
  agentId: null,
  content,
  createdAt,
  id,
  reactions: [],
  role: 'user',
  rootMessageId: null,
  threadId: 'thread-1',
})

const page = (
  data: ThreadMessageRecord[],
  nextCursor: string | null,
): ThreadMessagePage => ({
  data,
  meta: {
    hasMore: nextCursor !== null,
    nextCursor,
    prevCursor: null,
  },
})

test('message pages flatten oldest-first and keep the newest copy of a boundary row', () => {
  const pages: ThreadMessagePages = {
    pageParams: [undefined, 'older-cursor'],
    pages: [
      page([
        message('m-3', '2026-09-04T10:03:00.000Z', 'fresh'),
        message('m-4', '2026-09-04T10:04:00.000Z'),
      ], 'older-cursor'),
      page([
        message('m-1', '2026-09-04T10:01:00.000Z'),
        message('m-2', '2026-09-04T10:02:00.000Z'),
        message('m-3', '2026-09-04T10:03:00.000Z', 'stale'),
      ], null),
    ],
  }

  const flattened = flattenThreadMessagePages(pages)
  assert.deepEqual(flattened.map((entry) => entry.id), ['m-1', 'm-2', 'm-3', 'm-4'])
  assert.equal(flattened[2]?.content, 'fresh')
})

test('the history fetch retains cursors and addresses a reply root safely', async () => {
  const calls: string[] = []
  const response = page([], null)
  const apiClient = {
    getPage: async (path: string) => {
      calls.push(path)
      return response
    },
  } as ApiClient

  assert.equal(await fetchThreadMessages(apiClient, 'thread/unsafe', 'cursor|1', 'root 1'), response)
  assert.deepEqual(calls, [
    '/api/threads/thread%2Funsafe/messages?before=cursor%7C1&rootMessageId=root+1',
  ])
})

test('channel prewarm and the screen share one infinite-query key and cursor rule', () => {
  const options = threadMessagesInfiniteQueryOptions({} as ApiClient, 'thread-1')
  const first = page([], 'cursor-2')
  const last = page([], null)

  assert.deepEqual(options.queryKey, threadKeys.messages('thread-1'))
  assert.equal(options.getNextPageParam?.(first, [first], undefined, [undefined]), 'cursor-2')
  assert.equal(options.getNextPageParam?.(last, [last], undefined, [undefined]), undefined)
})

test('a streamed completion updates only the newest cached page', () => {
  const existing: ThreadMessagePages = {
    pageParams: [undefined, 'older-cursor'],
    pages: [
      page([message('m-3', '2026-09-04T10:03:00.000Z')], 'older-cursor'),
      page([message('m-1', '2026-09-04T10:01:00.000Z')], null),
    ],
  }
  const updated = upsertNewestThreadMessage(
    existing,
    message('m-4', '2026-09-04T10:04:00.000Z'),
  )

  assert.deepEqual(updated?.pages.map((entry) => entry.data.map((row) => row.id)), [
    ['m-3', 'm-4'],
    ['m-1'],
  ])
  assert.deepEqual(updated?.pageParams, existing.pageParams)
})

test('a streamed completion creates the first cache page when history has not arrived', () => {
  const streamed = message('m-1', '2026-09-04T10:01:00.000Z')
  assert.deepEqual(upsertNewestThreadMessage(undefined, streamed), {
    pageParams: [undefined],
    pages: [{
      data: [streamed],
      meta: { hasMore: false, nextCursor: null, prevCursor: null },
    }],
  })
})

test('every message scroller is wired to the shared older-history loader', async () => {
  const surfaces = [
    ['../src/pages/ChannelsPage.tsx', 'fetchOlderThreadMessages({ cancelRefetch: false })'],
    [
      '../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
      'repliesQuery.fetchNextPage({ cancelRefetch: false })',
    ],
    [
      '../src/components/features/channels/ChannelUserInfoDrawer.tsx',
      'messageHistory.fetchNextPage({ cancelRefetch: false })',
    ],
    [
      '../src/components/features/channels/ChannelAgentInfoDrawer.tsx',
      'useStickToBottom(agent?.id, true, threadMessageLoader)',
    ],
  ] as const

  for (const [relativePath, expectedWiring] of surfaces) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
    assert.ok(source.includes(expectedWiring), `${relativePath} must load older history`)
  }
})
