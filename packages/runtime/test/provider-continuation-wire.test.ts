import assert from 'node:assert/strict'
import test from 'node:test'

import { createConnectorRegistry } from '../src/inference/connectors/registry.js'
import type { ModelProviderConfig, ProviderMessage } from '../src/inference/types.js'

const correction = 'Continue the authorized unfinished work. Do not repeat completed actions.'
const messages: ProviderMessage[] = [
  { role: 'system', content: 'Initial policy.' },
  { role: 'system', content: 'Initial context.' },
  { role: 'user', content: 'Measure disk size once.' },
  { role: 'assistant', content: 'I will check.' },
  { role: 'system', content: correction },
]
const routes: Array<{ name: string; config: ModelProviderConfig }> = [
  { name: 'OpenAI', config: { provider: 'openai', apiKey: 'test' } },
  { name: 'OpenAI-compatible', config: { provider: 'openai-compatible', apiKey: 'test', baseUrl: 'https://example.invalid/v1' } },
  { name: 'DeepSeek', config: { provider: 'deepseek', apiKey: 'test', baseUrl: 'https://ledger.unlikeotherai.com/v1/deepseek' } },
  { name: 'OpenRouter', config: { provider: 'openai-compatible', apiKey: 'test', serviceId: 'openrouter' } },
  { name: 'DashScope', config: { provider: 'openai-compatible', apiKey: 'test', serviceId: 'alibaba' } },
  { name: 'Grok', config: { provider: 'openai-compatible', apiKey: 'test', baseUrl: 'https://cli-chat-proxy.grok.com/v1' } },
  { name: 'Codex', config: { provider: 'codex-subscription', apiKey: 'test' } },
]

for (const { name, config } of routes) {
  for (const streaming of [false, true]) {
    test(`${name} keeps continuation order and tool availability (stream=${streaming})`, async () => {
      let body: Record<string, unknown> | undefined
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (config.provider === 'codex-subscription') {
          const result = { status: 'completed', output: [{
            type: 'function_call', call_id: 'call_1', name: 'disk_probe', arguments: '{}',
          }] }
          const events = [
            { type: 'response.output_item.added', item: { ...result.output[0], id: 'fc_1', arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' },
            { type: 'response.completed', response: result },
          ]
          return new Response(body.stream
            ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
            : JSON.stringify(result))
        }
        const toolCalls = [{ index: 0, id: 'call_1', type: 'function', function: { name: 'disk_probe', arguments: '{}' } }]
        return new Response(body.stream
          ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }] }))
      }) as typeof fetch
      try {
        const connector = createConnectorRegistry().getConfigured(config)
        const request = {
          messages, requestId: 'continuation', model: 'test-model',
          tools: [{ toolName: 'disk_probe', description: 'Measure once.', inputSchema: { type: 'object' } }],
        }
        const run = async () => {
          if (!streaming) return connector.invoke(request)
          const stream = connector.stream!(request)
          let next = await stream.next()
          while (!next.done) next = await stream.next()
          return next.value
        }
        const result = await run()
        assert.deepEqual(result.toolCalls.map((call) => call.toolName), ['disk_probe'])
        assert.ok(Array.isArray(body?.tools) && body.tools.length === 1)
        if (config.provider === 'codex-subscription') {
          assert.equal(body?.instructions, 'Initial policy.\n\nInitial context.')
          assert.deepEqual(body?.input, [
            { role: 'user', content: [{ type: 'input_text', text: 'Measure disk size once.' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: 'I will check.' }] },
            { role: 'developer', content: [{ type: 'input_text', text: correction }] },
          ])
        } else {
          const wire = body?.messages as Array<{ role: string; content: string }>
          assert.deepEqual(wire.map((message) => message.role), ['system', 'system', 'user', 'assistant', 'system'])
          assert.deepEqual(wire.at(-1), { role: 'system', content: correction })
        }
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }
}
