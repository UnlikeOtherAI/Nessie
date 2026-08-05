import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import {
  createThinkingRecorder,
  REASONING_FLUSH_BYTES,
  REASONING_FLUSH_MS,
} from './thinking-recorder.js'

const RUN_ID = '00000000-0000-0000-0000-0000000000d1'
const THREAD_ID = '00000000-0000-0000-0000-0000000000e1'

type Written = { content: string; kind: string }
type Published = { event: string; data: Record<string, unknown> }

const makeHarness = (options: { failWrites?: boolean } = {}) => {
  const written: Written[] = []
  const published: Published[] = []
  let nextId = 1n

  const prisma = {
    runThinkingChunk: {
      create: async (args: { data: Written }) => {
        if (options.failWrites) {
          throw new Error('db down')
        }
        written.push({ content: args.data.content, kind: args.data.kind })
        const id = nextId
        nextId += 1n
        return { id }
      },
    },
  } as unknown as PrismaClient

  const realtimeTransport = {
    publishSse: async (_threadId: string, event: string, data: Record<string, unknown>) => {
      published.push({ data, event })
      return undefined as never
    },
  } as unknown as Pick<PgRealtimeTransport, 'publishSse'>

  const recorder = createThinkingRecorder({
    prisma,
    realtimeTransport,
    runId: RUN_ID,
    threadId: THREAD_ID,
  })
  return { published, recorder, written }
}

test('small reasoning deltas coalesce until close', async () => {
  const { published, recorder, written } = makeHarness()

  await recorder.appendReasoning('Think')
  await recorder.appendReasoning('ing ')
  await recorder.appendReasoning('about it.')
  assert.equal(written.length, 0, 'nothing is written before a flush threshold')

  await recorder.close()
  assert.deepEqual(written, [{ content: 'Thinking about it.', kind: 'reasoning' }])
  assert.equal(published.length, 1)
  assert.equal(published[0]!.event, 'stream.reasoning')
  assert.equal(published[0]!.data.content, 'Thinking about it.')
  assert.equal(published[0]!.data.runId, RUN_ID)
})

test('chunk ids are published as strings (BigInt is not JSON-serializable)', async () => {
  const { published, recorder } = makeHarness()

  await recorder.appendReasoning('one')
  await recorder.close()
  assert.equal(typeof published[0]!.data.chunkId, 'string')
  assert.equal(published[0]!.data.chunkId, '1')
  assert.doesNotThrow(() => JSON.stringify(published[0]!.data))
})

test('a buffer at or above the size threshold flushes immediately', async () => {
  const { recorder, written } = makeHarness()

  await recorder.appendReasoning('x'.repeat(REASONING_FLUSH_BYTES - 1))
  assert.equal(written.length, 0)

  await recorder.appendReasoning('y')
  assert.equal(written.length, 1)
  assert.equal(written[0]!.content.length, REASONING_FLUSH_BYTES)

  // The buffer is drained by the flush, so the next close writes nothing.
  await recorder.close()
  assert.equal(written.length, 1)
})

test('a waiting buffer flushes on its own once the age threshold passes', async () => {
  const { recorder, written } = makeHarness()

  await recorder.appendReasoning('slow thought')
  assert.equal(written.length, 0)

  await delay(REASONING_FLUSH_MS * 3)
  assert.deepEqual(written, [{ content: 'slow thought', kind: 'reasoning' }])

  await recorder.close()
  assert.equal(written.length, 1, 'close does not re-emit an already flushed buffer')
})

test('a tool line flushes pending reasoning first, then records the tool chunk', async () => {
  const { published, recorder, written } = makeHarness()

  await recorder.appendReasoning('I should look at the channels.')
  await recorder.appendToolLine('channel_list', 'limit=5')

  assert.deepEqual(written, [
    { content: 'I should look at the channels.', kind: 'reasoning' },
    { content: 'channel_list: limit=5', kind: 'tool' },
  ])
  assert.deepEqual(published.map((call) => call.event), [
    'stream.reasoning',
    'stream.thinking.tool',
  ])
  // Ids follow emission order, which is what lets a client merge history.
  assert.deepEqual(published.map((call) => call.data.chunkId), ['1', '2'])
})

test('a tool line with no input summary records just the tool name', async () => {
  const { recorder, written } = makeHarness()

  await recorder.appendToolLine('channel_list', '')
  assert.deepEqual(written, [{ content: 'channel_list', kind: 'tool' }])
})

test('close is idempotent and stops later appends', async () => {
  const { recorder, written } = makeHarness()

  await recorder.appendReasoning('final thought')
  await recorder.close()
  await recorder.close()
  await recorder.close()
  assert.equal(written.length, 1)

  await recorder.appendReasoning('too late')
  await recorder.appendToolLine('channel_list', 'limit=5')
  await recorder.close()
  assert.equal(written.length, 1, 'a closed recorder records nothing further')
})

test('recorder failures are swallowed — thinking capture never fails a run', async () => {
  const { published, recorder, written } = makeHarness({ failWrites: true })

  await recorder.appendReasoning('x'.repeat(REASONING_FLUSH_BYTES))
  await recorder.appendToolLine('channel_list', 'limit=5')
  await recorder.close()

  assert.equal(written.length, 0)
  assert.equal(published.length, 0, 'a failed durable write publishes nothing')
})
