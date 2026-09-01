import assert from 'node:assert/strict'
import test from 'node:test'

import { StreamDoneEventSchema } from '../realtime-sse.js'
import { WsEventSchema } from '../realtime-ws.js'

/**
 * Contract tests for the disclosure-restricted realtime shapes.
 *
 * A restricted agent message is published **content-free**: WS scopes are
 * channel- and organization-wide, so a preview would reach every connected
 * member regardless of entitlement — a leak no read-side predicate can close.
 *
 * These exist because the content-free publish was written but never parsed in
 * a test: every worker suite stubs `publishWs` as a no-op, so a schema that
 * still required `contentPreview` shipped. `publishWs` parses through
 * `WsEventSchema`, so the shape threw a ZodError on every restricted message —
 * failing the run instead of closing the wire. Parse the real shapes here.
 */

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const THREAD_ID = '33333333-3333-4333-8333-333333333333'
const RUN_ID = '44444444-4444-4444-8444-444444444444'

const wsEnvelope = (event: string, data: unknown) => ({
  type: 'event',
  event,
  data,
  ts: new Date().toISOString(),
})

const messageBase = {
  agentId: AGENT_ID,
  channelId: CHANNEL_ID,
  messageId: 'message-1',
  role: 'assistant',
  threadId: THREAD_ID,
}

test('message.new accepts the content-free restricted shape', () => {
  const parsed = WsEventSchema.safeParse(
    wsEnvelope('message.new', { ...messageBase, restricted: true }),
  )
  assert.equal(parsed.success, true, 'a restricted message must publish, not throw')
})

test('message.new still accepts an ordinary preview', () => {
  const parsed = WsEventSchema.safeParse(
    wsEnvelope('message.new', { ...messageBase, contentPreview: 'hello' }),
  )
  assert.equal(parsed.success, true)
})

test('message.reply accepts the content-free restricted shape', () => {
  const parsed = WsEventSchema.safeParse(
    wsEnvelope('message.reply', {
      ...messageBase,
      rootMessageId: 'root-1',
      restricted: true,
    }),
  )
  assert.equal(parsed.success, true, 'a restricted reply must publish, not throw')
})

test('the restricted marker survives parsing rather than being stripped', () => {
  // zod strips undeclared keys, so an undeclared marker reaches no client and
  // the terminator reads as an ordinary empty-content completion.
  const parsed = StreamDoneEventSchema.parse({
    runId: RUN_ID,
    messageId: 'message-1',
    agentId: AGENT_ID,
    restricted: true,
  })
  assert.equal(parsed.restricted, true)
})

test('an unrestricted stream.done carries no marker', () => {
  const parsed = StreamDoneEventSchema.parse({
    runId: RUN_ID,
    messageId: 'message-1',
    content: 'the answer',
  })
  assert.equal(parsed.restricted, undefined)
  assert.equal(parsed.content, 'the answer')
})

test('agent.todo.updated accepts only the id-only invalidation payload', () => {
  const todoId = '55555555-5555-4555-8555-555555555555'
  const parsed = WsEventSchema.safeParse(wsEnvelope('agent.todo.updated', {
    agentId: AGENT_ID,
    todoId,
  }))
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.deepEqual(parsed.data.data, { agentId: AGENT_ID, todoId })
  assert.doesNotMatch(JSON.stringify(parsed.data.data), /step|title|note|content/i)
})
