import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnectorRegistry } from '../src/inference/connectors.js'
import type { ProviderInvocationRequest } from '../src/inference/types.js'

const makeRequest = (overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest => ({
  requestId: 'req-1',
  correlationId: 'corr-1',
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'gpt-5-mini',
  ...overrides,
})

test('OpenAI connector passes abort signal to fetch', async () => {
  const capturedSignals: (AbortSignal | undefined)[] = []
  
  // Mock global fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedSignals.push(init?.signal)
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
      model: 'gpt-5-mini',
    }), { status: 200 })
  }

  try {
    const registry = createConnectorRegistry()
    const connector = registry.getConfigured({
      apiKey: 'test-key',
      provider: 'openai',
    })

    const controller = new AbortController()
    await connector.invoke(makeRequest({ signal: controller.signal }))
    
    assert.equal(capturedSignals.length, 1)
    assert.equal(capturedSignals[0], controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenAI connector uses bounded error body on HTTP error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    return new Response('x'.repeat(2000), { status: 500 })
  }

  try {
    const registry = createConnectorRegistry()
    const connector = registry.getConfigured({
      apiKey: 'test-key',
      provider: 'openai',
    })

    await assert.rejects(
      () => connector.invoke(makeRequest()),
      (err: Error) => {
        assert.ok(err.message.includes('openai model error 500:'))
        // Error message should be capped at 400 chars
        const errorPart = err.message.split('openai model error 500: ')[1]
        assert.ok(errorPart)
        assert.equal(errorPart.length, 400)
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('MiniMax connector passes abort signal to fetch', async () => {
  const capturedSignals: (AbortSignal | undefined)[] = []
  
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedSignals.push(init?.signal)
    return new Response('data: [DONE]\n\n', { status: 200 })
  }

  try {
    const registry = createConnectorRegistry()
    const connector = registry.getConfigured({
      apiKey: 'test-key',
      provider: 'minimax',
    })

    const controller = new AbortController()
    await connector.invoke(makeRequest({ signal: controller.signal }))
    
    assert.equal(capturedSignals.length, 1)
    assert.equal(capturedSignals[0], controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Kimi connector passes abort signal to fetch', async () => {
  const capturedSignals: (AbortSignal | undefined)[] = []
  
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedSignals.push(init?.signal)
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Hi' }],
      id: 'msg-1',
      model: 'kimi-for-coding',
      role: 'assistant',
      type: 'message',
    }), { status: 200 })
  }

  try {
    const registry = createConnectorRegistry()
    const connector = registry.getConfigured({
      apiKey: 'test-key',
      provider: 'kimi',
    })

    const controller = new AbortController()
    await connector.invoke(makeRequest({ signal: controller.signal }))
    
    assert.equal(capturedSignals.length, 1)
    assert.equal(capturedSignals[0], controller.signal)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AbortController aborts the underlying fetch on timeout', async () => {
  const originalFetch = globalThis.fetch
  let fetchAborted = false
  
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise((_, reject) => {
      const onAbort = () => {
        fetchAborted = true
        reject(new Error('AbortError'))
      }
      
      if (init?.signal?.aborted) {
        onAbort()
        return
      }
      
      init?.signal?.addEventListener('abort', onAbort)
      
      // Never resolve - simulating a hanging request
      setTimeout(() => {
        init?.signal?.removeEventListener('abort', onAbort)
      }, 10000)
    })
  }

  try {
    const registry = createConnectorRegistry()
    const connector = registry.getConfigured({
      apiKey: 'test-key',
      provider: 'openai',
    })

    const controller = new AbortController()
    
    // Abort after 50ms
    setTimeout(() => controller.abort(), 50)
    
    await assert.rejects(
      () => connector.invoke(makeRequest({ signal: controller.signal })),
      (err: Error) => {
        assert.ok(fetchAborted, 'fetch should have been aborted')
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
