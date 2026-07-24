import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockLlmServer, MOCK_EMBEDDING_DIMENSIONS } from './server.js'
import { loadScenario } from './scenario.js'

const chatRequest = (body: Record<string, unknown>) => ({
  body: JSON.stringify({
    messages: [{ content: 'go', role: 'user' }],
    model: 'mock-model',
    ...body,
  }),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
})

test('non-stream chat completion returns an OpenAI-shaped response', async () => {
  const server = await createMockLlmServer({ scenario: await loadScenario('simple-answer') })
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, chatRequest({}))
    assert.equal(response.status, 200)
    const body = await response.json() as {
      choices: Array<{ finish_reason: string; message: { content: string; role: string } }>
      model: string
      usage: { total_tokens: number }
    }
    assert.equal(body.model, 'mock-model')
    assert.equal(body.choices[0]?.message.role, 'assistant')
    assert.ok((body.choices[0]?.message.content.length ?? 0) > 0)
    assert.equal(body.choices[0]?.finish_reason, 'stop')
    assert.equal(body.usage.total_tokens, 74)
  } finally {
    await server.close()
  }
})

test('streaming completion emits SSE chunks, finish reason, usage, and DONE', async () => {
  const server = await createMockLlmServer({ scenario: await loadScenario('simple-answer') })
  try {
    const response = await fetch(
      `${server.url}/v1/chat/completions`,
      chatRequest({ stream: true, stream_options: { include_usage: true } }),
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

    const raw = await response.text()
    assert.match(raw, /data: \[DONE\]/)
    const chunks = raw
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)) as {
        choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
        usage?: { total_tokens: number }
      })

    const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')
    assert.equal(
      text,
      'This is a deterministic mock answer, streamed in fixed-size chunks.',
    )
    assert.ok(chunks.some((chunk) => chunk.choices[0]?.finish_reason === 'stop'))
    assert.equal(chunks.at(-1)?.usage?.total_tokens, 74)
  } finally {
    await server.close()
  }
})

test('tool-call turn streams function calls and a tool_calls finish reason', async () => {
  const server = await createMockLlmServer({ scenario: await loadScenario('channel-list-tool') })
  try {
    const response = await fetch(
      `${server.url}/v1/chat/completions`,
      chatRequest({ stream: true }),
    )
    const raw = await response.text()
    assert.match(raw, /"tool_calls"/)
    assert.match(raw, /channel_list/)
    assert.match(raw, /"finish_reason":"tool_calls"/)
  } finally {
    await server.close()
  }
})

test('scripted failure turns return the scripted HTTP error shape', async () => {
  const server = await createMockLlmServer({ scenario: await loadScenario('rate-limited') })
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, chatRequest({}))
    assert.equal(response.status, 429)
    const body = await response.json() as {
      error: { code: string; message: string; type: string }
    }
    assert.equal(body.error.type, 'rate_limit_error')
    assert.equal(body.error.code, 'rate_limit_exceeded')
  } finally {
    await server.close()
  }
})

test('embeddings returns deterministic vectors at the pgvector dimension', async () => {
  const server = await createMockLlmServer({ scenario: await loadScenario('simple-answer') })
  try {
    const response = await fetch(`${server.url}/v1/embeddings`, {
      body: JSON.stringify({ input: 'hello' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { data: Array<{ embedding: number[] }> }
    assert.equal(body.data[0]?.embedding.length, MOCK_EMBEDDING_DIMENSIONS)
    assert.equal(body.data[0]?.embedding[0], 1)
  } finally {
    await server.close()
  }
})

test('health and models endpoints answer like a provider', async () => {
  const server = await createMockLlmServer({ scenario: await loadScenario('simple-answer') })
  try {
    const health = await fetch(`${server.url}/health`)
    assert.equal(health.status, 200)
    const models = await fetch(`${server.url}/v1/models`)
    const body = await models.json() as { data: Array<{ id: string }> }
    assert.equal(body.data[0]?.id, 'mock-model')

    const missing = await fetch(`${server.url}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
  }
})
