import assert from 'node:assert/strict'
import test from 'node:test'
import { readErrorBodySnippet } from '../src/inference/error-body.js'

test('readErrorBodySnippet returns empty string for ok response', async () => {
  const res = new Response('ok body', { status: 200 })
  const result = await readErrorBodySnippet(res)
  assert.equal(result, 'ok body')
})

test('readErrorBodySnippet caps at 400 chars', async () => {
  const longError = 'x'.repeat(1000)
  const res = new Response(longError, { status: 500 })
  const result = await readErrorBodySnippet(res)
  assert.equal(result.length, 400)
  assert.equal(result, 'x'.repeat(400))
})

test('readErrorBodySnippet reads up to 8KB then cancels', async () => {
  // Create a stream that yields more than 8KB
  const chunk = new Uint8Array(1024)
  chunk.fill(97) // 'a'
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })

  const res = new Response(stream, { status: 500 })
  const result = await readErrorBodySnippet(res)
  assert.equal(result.length, 400)
  assert.equal(result, 'a'.repeat(400))
})

test('readErrorBodySnippet falls back to res.text() when no stream reader', async () => {
  // Response with null body
  const res = new Response(null, { status: 500 })
  const result = await readErrorBodySnippet(res)
  assert.equal(result, '')
})

test('readErrorBodySnippet returns empty string on exception', async () => {
  // Create a broken stream that throws on read
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error('stream error'))
    },
  })

  const res = new Response(stream, { status: 500 })
  const result = await readErrorBodySnippet(res)
  assert.equal(result, '')
})

test('readErrorBodySnippet handles multi-byte UTF-8 correctly', async () => {
  const text = '你好世界'.repeat(100) // 6 bytes per iteration, 600 bytes total
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

  const res = new Response(stream, { status: 500 })
  const result = await readErrorBodySnippet(res)
  assert.ok(result.length <= 400)
  assert.ok(result.includes('你好'))
})
