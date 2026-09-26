import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageRefChip } from '../src/components/features/channels/MessageRefChip.js'
import {
  buildFeedMessageRefs,
  FeedMessageRefsContext,
  type FeedMessageRefs,
} from '../src/components/features/channels/feed-message-refs.js'
import type { ThreadMessageRecord } from '../src/lib/api-client.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

/**
 * A one-on-one reply Jev put in the main chat with a link back to the earlier
 * message it is about (docs/standards/reply-threads.md → "One-on-one rooms").
 * The link shows that message as the reader's own feed has it and goes there;
 * nothing about it is stored on the reply except the id.
 */

const ME = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const EARLIER = '33333333-3333-4333-8333-333333333333'

const message = (overrides: Partial<ThreadMessageRecord>): ThreadMessageRecord => ({
  content: '',
  createdAt: '2026-09-26T10:00:00.000Z',
  id: EARLIER,
  role: 'user',
  threadId: '44444444-4444-4444-8444-444444444444',
  ...overrides,
})

const refsFor = (messages: ThreadMessageRecord[], jumpTo?: (id: string) => void) =>
  buildFeedMessageRefs(messages, {
    agentName: () => 'Ledger Clerk',
    ...(jumpTo ? { jumpTo } : {}),
    meUserId: ME,
  })

test('the feed names the earlier message by who wrote it and how it starts', () => {
  const refs = refsFor([
    message({ content: 'launch je 12. října,\n\n  zapamatuj si to', userId: ME }),
    message({ agentId: AGENT, content: 'Noted.', id: '55555555-5555-4555-8555-555555555555', role: 'assistant' }),
  ])
  assert.deepEqual(refs.find(EARLIER), { authorName: 'You', excerpt: 'launch je 12. října, zapamatuj si to' })
  assert.deepEqual(refs.find('55555555-5555-4555-8555-555555555555'), { authorName: 'Ledger Clerk', excerpt: 'Noted.' })
})

test('a withheld message is named but not quoted, and a deleted or unloaded one is not found', () => {
  assert.deepEqual(refsFor([message({ content: '', restricted: true, userId: ME })]).find(EARLIER), {
    authorName: 'You', excerpt: '',
  })
  assert.equal(refsFor([message({ deletedAt: '2026-09-26T11:00:00.000Z', userId: ME })]).find(EARLIER), null)
  assert.equal(refsFor([]).find(EARLIER), null)
})

test('a long earlier message is cut to one line', () => {
  const found = refsFor([message({ content: 'x'.repeat(400), userId: ME })]).find(EARLIER)
  assert.ok(found)
  assert.equal(found.excerpt.length, 141)
  assert.ok(found.excerpt.endsWith('…'))
})

const render = (
  metadata: Record<string, unknown> | undefined,
  refs: FeedMessageRefs | null,
  onOpenThread?: (id: string) => void,
) =>
  renderToStaticMarkup(createElement(
    FeedMessageRefsContext.Provider,
    { value: refs },
    createElement(MessageRefChip, { metadata, ...(onOpenThread ? { onOpenThread } : {}) }),
  ))

test('a reply with a messageRef shows the earlier message as a link to it', () => {
  const html = render(
    { messageRef: { messageId: EARLIER } },
    refsFor([message({ content: 'launch je 12. října', userId: ME })], () => undefined),
  )
  assert.match(html, /data-testid="message-ref-chip"/)
  assert.match(html, /<button/)
  assert.match(html, /aria-label="Go to the earlier message from You"/)
  assert.match(html, /launch je 12\. října/)
})

test('an earlier message the feed has not loaded still links, through its thread', () => {
  const html = render({ messageRef: { messageId: EARLIER } }, refsFor([], () => undefined), () => undefined)
  assert.match(html, /<button/)
  assert.match(html, /Earlier message/)
})

test('with nowhere to go the reference is shown but is not a button', () => {
  const html = render({ messageRef: { messageId: EARLIER } }, refsFor([message({ content: 'hi', userId: ME })]))
  assert.doesNotMatch(html, /<button/)
  assert.match(html, /data-testid="message-ref-chip"/)
})

test('a message without a well-formed messageRef renders nothing', () => {
  assert.equal(render(undefined, null), '')
  assert.equal(render({ messageRef: { messageId: 'not-a-uuid' } }, null), '')
  assert.equal(render({ documentRef: { pageId: EARLIER } }, null), '')
})
