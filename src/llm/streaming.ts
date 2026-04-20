/**
 * src/llm/streaming.ts — Streaming LLM client.
 * Yields text deltas as the model generates them.
 * Compatible with OpenAI Chat Completions and MiniMax streaming APIs.
 */

import type { LlmMessage } from './client.js'

export type LlmStreamOptions = {
  model?: string
  maxTokens?: number
  temperature?: number
}

// Safety net: if a streaming response is abandoned and the generator is GC'd
// before completion, FinalizationRegistry ensures the reader is cancelled and
// released back to the connection pool, preventing socket leaks.
// See: openclaw/openclaw#67461
const streamFinalizationRegistry = new FinalizationRegistry<ReadableStreamDefaultReader<any>>(
  (reader) => {
    reader.cancel().catch(() => { /* ignore cancel errors on already-resolved streams */ })
    reader.releaseLock()
  },
)

/**
 * Yields text deltas from the model. Throws on API error after zero or more deltas.
 */
export async function* llmStream(
  messages: LlmMessage[],
  options: LlmStreamOptions = {},
): AsyncGenerator<string, void, undefined> {
  const provider = process.env.LLM_PROVIDER ?? 'openai'

  if (provider === 'minimax') {
    yield* minimaxStream(messages, options)
  } else {
    yield* openaiStream(messages, options)
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function* openaiStream(
  messages: LlmMessage[],
  options: LlmStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const apiKey = process.env.OPENAI_CHAT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? 'gpt-4o',
      messages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.7,
      stream: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI streaming error ${res.status}: ${err}`)
  }

  if (!res.body) throw new Error('OpenAI response has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer: string = "" as string

  // Register reader with finalization registry as a safety net for abandoned streams
  (streamFinalizationRegistry as FinalizationRegistry<unknown>).register(reader, reader)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[]
          }
          const text = chunk.choices?.[0]?.delta?.content
          if (text) yield text
        } catch {
          // ignore malformed JSON
        }
      }
    }
  } finally {
    (streamFinalizationRegistry as FinalizationRegistry<unknown>).unregister(reader)
    // Cancel the reader to release the underlying socket back to the pool.
    // This is safe to call even if the stream is already done.
    await reader.cancel().catch(() => { /* ignore cancel errors */ })
    reader.releaseLock()
  }
}

// ─── MiniMax ──────────────────────────────────────────────────────────────────

async function* minimaxStream(
  messages: LlmMessage[],
  options: LlmStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) throw new Error('MINIMAX_API_KEY is not set')

  const res = await fetch('https://api.minimax.io/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? 'MiniMax-M2.5',
      messages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.7,
      stream: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`MiniMax streaming error ${res.status}: ${err}`)
  }

  if (!res.body) throw new Error('MiniMax response has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer: string = "" as string

  // Register reader with finalization registry as a safety net for abandoned streams
  (streamFinalizationRegistry as FinalizationRegistry<unknown>).register(reader, reader)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[]
          }
          const text = chunk.choices?.[0]?.delta?.content
          if (text) yield text
        } catch {
          // ignore malformed JSON
        }
      }
    }
  } finally {
    (streamFinalizationRegistry as FinalizationRegistry<unknown>).unregister(reader)
    // Cancel the reader to release the underlying socket back to the pool.
    // This is safe to call even if the stream is already done.
    await reader.cancel().catch(() => { /* ignore cancel errors */ })
    reader.releaseLock()
  }
}
