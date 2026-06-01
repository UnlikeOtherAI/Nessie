import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { llmStream, type LlmStreamOptions } from './streaming.js'

function makeMockStream(chunks: Array<{ text: string; delayMs: number }>): ReadableStream<Uint8Array> {
  let index = 0
  const encoder = new TextEncoder()
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      const chunk = chunks[index++]
      await new Promise((r) => setTimeout(r, chunk.delayMs))
      controller.enqueue(encoder.encode(chunk.text))
    },
  })
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function doneLine(): string {
  return 'data: [DONE]\n\n'
}

function chunkWithContent(content: string): string {
  return sseLine({ choices: [{ delta: { content } }] })
}

describe('StreamingWatchdog', () => {
  const originalEnv = process.env.LLM_STREAM_IDLE_MS

  beforeEach(() => {
    delete process.env.LLM_STREAM_IDLE_MS
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_CHAT_API_KEY', 'test-key')
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.LLM_STREAM_IDLE_MS = originalEnv
    } else {
      delete process.env.LLM_STREAM_IDLE_MS
    }
    vi.unstubAllEnvs()
  })

  it('aborts a slow stream that exceeds default idle timeout (~30s)', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const stream = makeMockStream([
      { text: chunkWithContent('hello'), delayMs: 100 },
      { text: chunkWithContent('world'), delayMs: 40_000 }, // exceeds 30s default
    ])

    fetchMock.mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response)

    const gen = llmStream([{ role: 'user', content: 'hi' }])
    const results: string[] = []
    let error: Error | undefined

    try {
      for await (const text of gen) {
        results.push(text)
      }
    } catch (err) {
      error = err as Error
    }

    expect(results).toEqual(['hello'])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/Streaming watchdog: no data received for 30000ms/)
  }, 60_000)

  it('completes a normal stream with 5s chunk intervals', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const stream = makeMockStream([
      { text: chunkWithContent('a'), delayMs: 5_000 },
      { text: chunkWithContent('b'), delayMs: 5_000 },
      { text: doneLine(), delayMs: 100 },
    ])

    fetchMock.mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response)

    const gen = llmStream([{ role: 'user', content: 'hi' }])
    const results: string[] = []

    for await (const text of gen) {
      results.push(text)
    }

    expect(results).toEqual(['a', 'b'])
  }, 60_000)

  it('aborts when custom idleTimeoutMs is set to 5000ms', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const stream = makeMockStream([
      { text: chunkWithContent('x'), delayMs: 100 },
      { text: chunkWithContent('y'), delayMs: 7_000 }, // exceeds 5s custom
    ])

    fetchMock.mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response)

    const options: LlmStreamOptions = { idleTimeoutMs: 5_000 }
    const gen = llmStream([{ role: 'user', content: 'hi' }], options)
    const results: string[] = []
    let error: Error | undefined

    try {
      for await (const text of gen) {
        results.push(text)
      }
    } catch (err) {
      error = err as Error
    }

    expect(results).toEqual(['x'])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/Streaming watchdog: no data received for 5000ms/)
  }, 60_000)

  it('uses LLM_STREAM_IDLE_MS env var as default', async () => {
    process.env.LLM_STREAM_IDLE_MS = '5000'

    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const stream = makeMockStream([
      { text: chunkWithContent('x'), delayMs: 100 },
      { text: chunkWithContent('y'), delayMs: 7_000 },
    ])

    fetchMock.mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response)

    const gen = llmStream([{ role: 'user', content: 'hi' }])
    const results: string[] = []
    let error: Error | undefined

    try {
      for await (const text of gen) {
        results.push(text)
      }
    } catch (err) {
      error = err as Error
    }

    expect(results).toEqual(['x'])
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/Streaming watchdog: no data received for 5000ms/)
  }, 60_000)

  it('does not leave lingering timers after normal completion', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const stream = makeMockStream([
      { text: chunkWithContent('done'), delayMs: 100 },
      { text: doneLine(), delayMs: 100 },
    ])

    fetchMock.mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response)

    const gen = llmStream([{ role: 'user', content: 'hi' }])
    const results: string[] = []

    for await (const text of gen) {
      results.push(text)
    }

    expect(results).toEqual(['done'])
    // If timers leak, vitest will warn; this test passes if no hang occurs.
  })

  it('error message includes the idle timeout value', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const stream = makeMockStream([
      { text: chunkWithContent('start'), delayMs: 100 },
      { text: chunkWithContent('stall'), delayMs: 12_000 },
    ])

    fetchMock.mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response)

    const options: LlmStreamOptions = { idleTimeoutMs: 10_000 }
    const gen = llmStream([{ role: 'user', content: 'hi' }], options)
    let error: Error | undefined

    try {
      for await (const _ of gen) { /* consume */ }
    } catch (err) {
      error = err as Error
    }

    expect(error).toBeDefined()
    expect(error!.message).toBe('Streaming watchdog: no data received for 10000ms')
  }, 60_000)
})
