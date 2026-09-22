import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { publishThreadStreamEvent } from '../src/realtime-durable-publish.js'

class FakeClient extends EventEmitter {
  releaseReason: unknown = 'not-called'
  async query(text: string) {
    if (text === 'BEGIN') return { rows: [] }
    if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('INSERT INTO thread_stream_events')) {
      const error = new Error('Connection terminated unexpectedly')
      this.emit('error', error)
      throw error
    }
    if (text === 'ROLLBACK') return { rows: [] }
    throw new Error(`unexpected query: ${text}`)
  }
  release(reason?: Error) {
    this.releaseReason = reason
  }
}

describe('withOrderedPublish client error', () => {
  it('captures a dropped connection without an uncaughtException and destroys the client', async () => {
    const client = new FakeClient()
    const pool = { connect: async () => client }
    let uncaught: Error | null = null
    const onUncaught = (error: Error) => { uncaught = error }
    process.once('uncaughtException', onUncaught)
    try {
      await assert.rejects(
        () =>
          publishThreadStreamEvent(pool as never, 'chan', {
            threadId: '00000000-0000-4000-8000-000000000001',
            event: 'stream.delta',
            data: {
              runId: '00000000-0000-4000-8000-000000000002',
              content: 'hi',
            },
          }),
        /Connection terminated unexpectedly/,
      )
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    assert.ok(
      client.releaseReason instanceof Error,
      `release() should receive the destroy reason, got ${String(client.releaseReason)}`,
    )
    assert.equal(uncaught, null)
  })
})
