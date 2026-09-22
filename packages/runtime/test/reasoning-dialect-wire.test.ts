import assert from 'node:assert/strict'
import test from 'node:test'

import { createConnectorRegistry } from '../src/inference/connectors/registry.js'
import {
  applyReasoningDialect,
  resolveReasoningDialect,
} from '../src/inference/connectors/reasoning-dialect.js'
import type {
  ModelProviderConfig,
  ProviderInvocationResult,
  ProviderMessage,
  ProviderStreamEvent,
} from '../src/inference/types.js'

/**
 * The thinking switch, the output-cap field and the reasoning replay are
 * decided per dialect at the transport boundary. These tests read the wire.
 */

const LEDGER = 'https://ledger.unlikeotherai.com/v1/alibaba'

const sse = (chunks: unknown[]): Response =>
  new Response(
    [...chunks, '[DONE]']
      .map((chunk) => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )

const drain = async (
  stream: AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined>,
): Promise<{ events: ProviderStreamEvent[]; result: ProviderInvocationResult }> => {
  const events: ProviderStreamEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}

const withFetch = async <T>(
  respond: (body: Record<string, unknown>) => Response,
  run: () => Promise<T>,
): Promise<{ bodies: Record<string, unknown>[]; value: T }> => {
  const originalFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(body)
    return respond(body)
  }) as typeof fetch
  try {
    return { bodies, value: await run() }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const turnWithReasoning: ProviderMessage[] = [
  { content: 'What is the weather?', role: 'user' },
  {
    content: null,
    reasoning: 'The user wants a forecast; call the tool.',
    role: 'assistant',
    toolCalls: [{ arguments: { city: 'London' }, toolCallId: 'call_1', toolName: 'weather' }],
  },
  { content: '{"forecast":"sunny"}', role: 'tool', toolCallId: 'call_1' },
]

const assistantOnWire = (body: Record<string, unknown>): Record<string, unknown> =>
  (body.messages as Record<string, unknown>[]).find((m) => m.role === 'assistant')!

test('the dialect is resolved from the provider and the Ledger service id only', () => {
  assert.equal(resolveReasoningDialect({ provider: 'deepseek' }), 'deepseek')
  assert.equal(resolveReasoningDialect({ provider: 'openai-compatible', serviceId: 'deepseek' }), 'deepseek')
  assert.equal(resolveReasoningDialect({ provider: 'openai-compatible', serviceId: 'alibaba' }), 'dashscope')
  assert.equal(resolveReasoningDialect({ provider: 'openai-compatible', serviceId: 'openrouter' }), 'openai')
  assert.equal(resolveReasoningDialect({ provider: 'openai', serviceId: 'openai' }), 'openai')
})

test('thinking is asked for on a streamed turn and switched off for silent and JSON calls', () => {
  const streamed = { messages: [], model: 'm', stream: true }
  const silent = { messages: [], model: 'm' }
  const json = { messages: [], model: 'm', response_format: { type: 'json_object' }, stream: true }

  assert.deepEqual(applyReasoningDialect('deepseek', streamed).thinking, { type: 'enabled' })
  assert.deepEqual(applyReasoningDialect('deepseek', silent).thinking, { type: 'disabled' })
  assert.deepEqual(applyReasoningDialect('deepseek', json).thinking, { type: 'disabled' })
  assert.equal(applyReasoningDialect('dashscope', streamed).enable_thinking, true)
  assert.equal(applyReasoningDialect('dashscope', silent).enable_thinking, false)
  assert.equal(applyReasoningDialect('dashscope', json).enable_thinking, false)
  assert.equal('enable_thinking' in applyReasoningDialect('openai', streamed), false)
  assert.equal('thinking' in applyReasoningDialect('openai', streamed), false)
})

test('a caller cannot re-enable thinking on a silent DeepSeek call through the raw body', () => {
  const body = applyReasoningDialect('deepseek', {
    max_completion_tokens: 99, messages: [], model: 'm', thinking: { type: 'enabled' },
  })
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.max_tokens, 99)
  assert.equal(body.max_completion_tokens, undefined)
})

test('the DashScope dialect (Ledger alibaba) streams with thinking on and replays reasoning', async () => {
  const connector = createConnectorRegistry().getConfigured({
    apiKey: 'lk', baseUrl: LEDGER, provider: 'openai-compatible', serviceId: 'alibaba',
  })
  const { bodies, value } = await withFetch(
    () => sse([
      { choices: [{ delta: { reasoning_content: 'Weighing ' } }] },
      { choices: [{ delta: { reasoning_content: 'the forecast.' } }] },
      { choices: [{ delta: { content: 'Sunny.' }, finish_reason: 'stop' }] },
    ]),
    () => drain(connector.stream!({
      messages: turnWithReasoning, model: 'deepseek-v3.2', reasoningEffort: 'medium', requestId: 'r1',
    })),
  )
  const body = bodies[0]!
  assert.equal(body.enable_thinking, true)
  assert.equal(body.reasoning_effort, 'medium')
  assert.equal(assistantOnWire(body).reasoning_content, 'The user wants a forecast; call the tool.')
  assert.deepEqual(
    value.events.filter((e) => e.type === 'reasoning_text.delta').map((e) => e.type === 'reasoning_text.delta' && e.text),
    ['Weighing ', 'the forecast.'],
  )
  assert.equal(value.result.reasoningText, 'Weighing the forecast.')
  assert.equal(value.result.outputText, 'Sunny.')
})

test('a silent DashScope call is non-thinking, which is the only mode it serves without a stream', async () => {
  const connector = createConnectorRegistry().getConfigured({
    apiKey: 'lk', baseUrl: LEDGER, provider: 'openai-compatible', serviceId: 'alibaba',
  })
  const { bodies } = await withFetch(
    () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })),
    () => connector.invoke({
      messages: [{ content: 'classify', role: 'user' }],
      model: 'qwen3.7-plus',
      requestId: 'r2',
      responseFormat: { type: 'json_object' },
    }),
  )
  assert.equal(bodies[0]!.enable_thinking, false)
  assert.equal(bodies[0]!.stream, undefined)
})

test('the OpenAI dialect never sends a thinking switch and strips replayed reasoning', async () => {
  const connector = createConnectorRegistry().getConfigured({
    apiKey: 'lk', baseUrl: 'https://ledger.unlikeotherai.com/v1/openrouter', provider: 'openai-compatible', serviceId: 'openrouter',
  })
  const { bodies, value } = await withFetch(
    () => sse([
      // OpenRouter's field name, which production's default route uses.
      { choices: [{ delta: { reasoning: 'Thinking it over.' } }] },
      { choices: [{ delta: { content: 'Sunny.' }, finish_reason: 'stop' }] },
    ]),
    () => drain(connector.stream!({
      messages: turnWithReasoning, model: 'meta/muse-spark-1.3', reasoningEffort: 'high', requestId: 'r3',
    })),
  )
  const body = bodies[0]!
  assert.equal('enable_thinking' in body, false)
  assert.equal('thinking' in body, false)
  assert.equal(body.reasoning_effort, 'high')
  assert.equal('reasoning_content' in assistantOnWire(body), false)
  assert.equal(value.result.reasoningText, 'Thinking it over.')
  assert.equal(value.events.some((e) => e.type === 'reasoning_text.delta'), true)
})

test('the raw completion escape hatch is normalised by the same dialect', async () => {
  const config: ModelProviderConfig = {
    apiKey: 'lk', baseUrl: LEDGER, provider: 'openai-compatible', serviceId: 'alibaba',
  }
  const connector = createConnectorRegistry().getConfigured(config)
  const { bodies } = await withFetch(
    () => sse([{ choices: [{ delta: { content: 'ok' } }] }]),
    () => connector.fetchCompletion({
      messages: [{ content: null, reasoning_content: 'kept', role: 'assistant', tool_calls: [] }],
      model: 'deepseek-v3.2',
      stream: true,
    }),
  )
  assert.equal(bodies[0]!.enable_thinking, true)
  assert.equal(assistantOnWire(bodies[0]!).reasoning_content, 'kept')
})

test('a non-streaming reply carries its reasoning under either field name', async () => {
  const connector = createConnectorRegistry().getConfigured({
    apiKey: 'lk', baseUrl: 'https://ledger.unlikeotherai.com/v1/deepseek', provider: 'deepseek', serviceId: 'deepseek',
  })
  const { bodies, value } = await withFetch(
    () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: 'Note.', reasoning_content: 'Silent thought.' } }],
    })),
    () => connector.invoke({ maxOutputTokens: 40, messages: [{ content: 'note', role: 'user' }], model: 'deepseek-v4-flash', requestId: 'r4' }),
  )
  assert.deepEqual(bodies[0]!.thinking, { type: 'disabled' })
  assert.equal(bodies[0]!.max_tokens, 40)
  assert.equal(bodies[0]!.max_completion_tokens, undefined)
  assert.equal(value.reasoningText, 'Silent thought.')
})

test('`none` switches thinking off in every dialect and never travels as an effort', () => {
  const body = { messages: [], model: 'm', reasoning_effort: 'none', stream: true }
  assert.deepEqual(applyReasoningDialect('deepseek', body).thinking, { type: 'disabled' })
  assert.equal(applyReasoningDialect('deepseek', body).reasoning_effort, undefined)
  assert.equal(applyReasoningDialect('dashscope', body).enable_thinking, false)
  assert.equal(applyReasoningDialect('dashscope', body).reasoning_effort, undefined)
  const openai = applyReasoningDialect('openai', body)
  assert.equal('reasoning_effort' in openai, false)
  assert.equal('thinking' in openai, false)
})
