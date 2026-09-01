import assert from 'node:assert/strict'
import test from 'node:test'
import type { InfiniteData } from '@tanstack/react-query'

import {
  markThreadActivityReadInCache,
  type ThreadActivityResponse,
} from '../src/facades/threads/activity-hooks.js'

const activity = (input: {
  rootMessageId: string
  threadId: string
  unread: boolean
}) => ({
  channelId: 'channel-1',
  channelLabel: 'general',
  latestReply: { content: 'Latest reply', createdAt: '2026-09-01T12:00:00.000Z', id: 'reply-1' },
  replyCount: 1,
  root: { content: 'Root', createdAt: '2026-09-01T11:00:00.000Z', id: input.rootMessageId },
  ...input,
})

test('marks one cached inbox card read without clearing its pages', () => {
  const unread = activity({ rootMessageId: 'root-unread', threadId: 'thread-1', unread: true })
  const alreadyRead = activity({ rootMessageId: 'root-read', threadId: 'thread-2', unread: false })
  const cache: InfiniteData<ThreadActivityResponse> = {
    pageParams: [undefined],
    pages: [{ hasMore: false, items: [unread, alreadyRead], unreadTotal: 1 }],
  }

  const result = markThreadActivityReadInCache(cache, {
    rootMessageId: unread.rootMessageId,
    threadId: unread.threadId,
  })

  assert.ok(result)
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0]?.items.length, 2)
  assert.equal(result.pages[0]?.items[0]?.unread, false)
  assert.equal(result.pages[0]?.items[1], alreadyRead)
  assert.equal(result.pages[0]?.unreadTotal, 0)
})

test('does not rewrite an activity cache that lacks the acknowledged thread', () => {
  const cache: InfiniteData<ThreadActivityResponse> = {
    pageParams: [undefined],
    pages: [{
      hasMore: false,
      items: [activity({ rootMessageId: 'root-1', threadId: 'thread-1', unread: true })],
      unreadTotal: 1,
    }],
  }

  assert.equal(
    markThreadActivityReadInCache(cache, { rootMessageId: 'root-2', threadId: 'thread-2' }),
    cache,
  )
})

test('removes an acknowledged card from the unread-only cache', () => {
  const unread = activity({ rootMessageId: 'root-unread', threadId: 'thread-1', unread: true })
  const cache: InfiniteData<ThreadActivityResponse> = {
    pageParams: [undefined],
    pages: [{ hasMore: true, items: [unread], unreadTotal: 4 }],
  }

  const result = markThreadActivityReadInCache(cache, {
    rootMessageId: unread.rootMessageId,
    threadId: unread.threadId,
    unreadOnly: true,
  })

  assert.ok(result)
  assert.deepEqual(result.pages[0]?.items, [])
  assert.equal(result.pages[0]?.unreadTotal, 3)
  assert.equal(result.pages[0]?.hasMore, true)
})
