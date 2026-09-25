import assert from 'node:assert/strict'
import test from 'node:test'

import { createKimiConnector } from '../src/inference/connectors/kimi.js'
import type { ProviderInvocationRequest, ProviderMessage } from '../src/inference/types.js'

const continuation = 'Continue the unfinished disk check. Call disk_probe once, then report its result.'
const toolText = '<tool_use>{"name":"disk_probe","arguments":{}}</tool_use>'
const answer = 'Disk: 1000 bytes total, 500 bytes free.'

// Captured behavior of the live Kimi Messages endpoint: an assistant prefill
// containing an already complete answer returns end_turn, seven output tokens,
// and no content blocks. A subsequent user turn requests a fresh response.
const responseFor = (text: string, stream: boolean): Response => stream
  ? new Response([
      { type: 'message_start', message: { usage: { input_tokens: 300, output_tokens: 0 } } },
      ...(text ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }] : []),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: text ? 32 : 7 } },
      { type: 'message_stop' },
    ].map((event) => `data:${JSON.stringify(event)}\n\n`).join(''))
  : new Response(JSON.stringify({
      content: text ? [{ type: 'text', text }] : [], stop_reason: 'end_turn', usage: { output_tokens: text ? 32 : 7 },
    }))

for (const stream of [false, true]) {
  for (const cache of [false, true]) {
    test(`Kimi continuation calls a tool and reports its result (stream=${stream}, cache=${cache})`, async () => {
      const requests: Array<{ messages: Array<{ role: string; content: unknown }>; system: unknown }> = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as typeof requests[number]
        requests.push(body)
        const isPrefill = body.messages.at(-1)?.role === 'assistant'
        return responseFor(isPrefill ? '' : requests.length === 1 ? toolText : answer, stream)
      }) as typeof fetch
      try {
        const connector = createKimiConnector({ apiKey: 'test', provider: 'kimi' })
        const invoke = async (request: ProviderInvocationRequest) => {
          if (!stream) return connector.invoke(request)
          const output = connector.stream!(request)
          let next = await output.next()
          while (!next.done) next = await output.next()
          return next.value
        }
        const messages: ProviderMessage[] = [
          { role: 'system', content: 'Use tools for measurements; never invent them.' },
          { role: 'user', content: 'Check the disk size once.' },
          { role: 'assistant', content: 'I will check the disk size now.' },
          { role: 'system', content: continuation },
        ]
        const request: ProviderInvocationRequest = {
          messages, requestId: 'continuation', ...(cache ? { promptCacheKey: 'stable' } : {}),
          tools: [{ toolName: 'disk_probe', description: 'Measure disk size.', inputSchema: { type: 'object' } }],
        }
        const call = await invoke(request)
        assert.equal(call.toolCalls.length, 1, 'the continuation must not end as an empty assistant prefill')
        assert.equal(call.toolCalls[0]?.toolName, 'disk_probe')
        assert.deepEqual(requests[0]?.messages.map((message) => message.role), ['user', 'assistant', 'user'])
        assert.ok(JSON.stringify(requests[0]?.messages.at(-1)?.content).includes(continuation))
        assert.ok(JSON.stringify(requests[0]?.system).includes('disk_probe'), 'authorized tools stay available')
        assert.equal(JSON.stringify(requests[0]?.system).includes(continuation), false)

        messages.push(
          { role: 'assistant', content: null, toolCalls: call.toolCalls },
          { role: 'tool', toolCallId: call.toolCalls[0]!.toolCallId, content: 'total=1000; free=500' },
          { role: 'system', content: 'Report the completed result and stop. Do not repeat the measurement.' },
        )
        const final = await invoke({ ...request, requestId: 'result' })
        assert.equal(final.outputText, answer)
        assert.deepEqual(final.toolCalls, [])
        assert.equal(requests.length, 2)
        const tail = JSON.stringify(requests[1]?.messages.at(-1)?.content)
        assert.ok(tail.indexOf('total=1000') < tail.indexOf('Report the completed result'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  }
}
