/**
 * src/llm/streaming.ts — Streaming LLM client.
 * Yields text deltas as the model generates them.
 * Compatible with OpenAI Chat Completions and MiniMax streaming APIs.
 */

import type { LlmMessage } from './client.js'
import { isRetryableInferenceError } from '../agent/dispatch.js'
import { partitionReasoningTags } from './reasoning-tag-stripper.js'

export type LlmStreamOptions = {
  model?: string
  maxTokens?: number
  temperature?: number
  /** Override base URL for OpenAI-compatible backends (used for failover primary). */
  baseUrl?: string
  /** Maximum time from request start to stream completion (seconds). Guards slow-starting or never-starting requests. */
  timeoutSeconds?: number
  /** Maximum milliseconds between consecutive chunks. Protects against stalled mid-stream connections. Defaults to 30000. */
  idleTimeoutMs?: number
}

class StreamingWatchdog {
  private idleMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null

  constructor(idleMs: number) {
    this.idleMs = idleMs
  }

  start(abortController: AbortController) {
    this.abortController = abortController
    this.resetTimer()
  }

  onChunk() {
    this.resetTimer()
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.abortController = null
  }

  private resetTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.abortController?.abort(
        new Error(`Streaming watchdog: no data received for ${this.idleMs}ms`)
      )
    }, this.idleMs)
  }
}

// Safety net: if a streaming response is abandoned and the generator is GC'd
// before completion, FinalizationRegistry ensures the reader is cancelled and
// released back to the connection pool, preventing socket leaks.
// See: openclaw/openclaw#67461
const streamFinalizationRegistry = new (globalThis as any).FinalizationRegistry(
  (reader: ReadableStreamDefaultReader<unknown>) => {
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
    // B2: Streaming failover.
    // The SSE response is a committed HTTP stream — once we've yielded deltas to the
    // client we cannot retry/rewind. Therefore streaming failover is only viable when
    // the primary fails BEFORE any yield (i.e. before the first delta is sent).
    // Once streaming starts, any error aborts the stream with no retry.
    // This is a known limitation of SSE streaming; non-streaming calls use the full
    // dispatchWithFailover() path.
    try {
      yield* openaiStream(messages, options)
    } catch (primaryErr) {
      if (options.baseUrl && isRetryableInferenceError(primaryErr as Error)) {
        console.warn(`[llmStream] Primary streaming failed (${(primaryErr as Error).message}), aborting stream`)
      }
      throw primaryErr
    }
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

async function* openaiStream(
  messages: LlmMessage[],
  options: LlmStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const apiKey = process.env.OPENAI_CHAT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY / OPENAI_CHAT_API_KEY is not set')

  const url = options.baseUrl ?? 'https://api.openai.com/v1/chat/completions'
  const res = await fetch(url, {
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
  let reasoningState: { inReasoning: boolean; buffer: string } = { inReasoning: false, buffer: '' }

  // Register reader with finalization registry as a safety net for abandoned streams
  ;(streamFinalizationRegistry as any).register(reader, reader)

  const idleTimeoutMs = options.idleTimeoutMs ?? (process.env.LLM_STREAM_IDLE_MS ? parseInt(process.env.LLM_STREAM_IDLE_MS, 10) : 30_000)
  const controller = new AbortController()
  const watchdog = new StreamingWatchdog(idleTimeoutMs)
  watchdog.start(controller)

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
            choices?: { delta?: { content?: string; reasoning_content?: string; thinking?: string; reasoning?: string } }[]
          }
          const delta = chunk.choices?.[0]?.delta
          const text = delta?.content
          // First, yield any separate reasoning fields (existing behaviour)
          const separateReasoning = delta?.reasoning_content ?? delta?.thinking ?? delta?.reasoning
          if (separateReasoning) {
            watchdog.onChunk()
            yield { type: 'reasoning', text: separateReasoning } as any
          }
          if (text) {
            const partitioned: any = partitionReasoningTags(text, reasoningState)
            reasoningState = partitioned.newState
            if (partitioned.result.reasoning) {
              watchdog.onChunk()
              yield { type: 'reasoning', text: partitioned.result.reasoning } as any
            }
            if (partitioned.result.content) {
              watchdog.onChunk()
              yield { type: 'content', text: partitioned.result.content } as any
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }
  } finally {
    watchdog.stop()
    ;(streamFinalizationRegistry as any).unregister(reader)
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

  // Note: MiniMax does not support custom baseUrl for text/chatcompletion_v2.
  // Fallback to the default endpoint. Failover for streaming is a known limitation.
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
  let reasoningState: { inReasoning: boolean; buffer: string } = { inReasoning: false, buffer: '' }

  // Register reader with finalization registry as a safety net for abandoned streams
  ;(streamFinalizationRegistry as any).register(reader, reader)

  const idleTimeoutMs = options.idleTimeoutMs ?? (process.env.LLM_STREAM_IDLE_MS ? parseInt(process.env.LLM_STREAM_IDLE_MS, 10) : 30_000)
  const controller = new AbortController()
  const watchdog = new StreamingWatchdog(idleTimeoutMs)
  watchdog.start(controller)

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
            choices?: { delta?: { content?: string; reasoning_content?: string; thinking?: string; reasoning?: string } }[]
          }
          const delta = chunk.choices?.[0]?.delta
          const text = delta?.content
          // First, yield any separate reasoning fields (existing behaviour)
          const separateReasoning = delta?.reasoning_content ?? delta?.thinking ?? delta?.reasoning
          if (separateReasoning) {
            watchdog.onChunk()
            yield { type: 'reasoning', text: separateReasoning } as any
          }
          if (text) {
            const partitioned: any = partitionReasoningTags(text, reasoningState)
            reasoningState = partitioned.newState
            if (partitioned.result.reasoning) {
              watchdog.onChunk()
              yield { type: 'reasoning', text: partitioned.result.reasoning } as any
            }
            if (partitioned.result.content) {
              watchdog.onChunk()
              yield { type: 'content', text: partitioned.result.content } as any
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }
  } finally {
    watchdog.stop()
    ;(streamFinalizationRegistry as any).unregister(reader)
    // Cancel the reader to release the underlying socket back to the pool.
    // This is safe to call even if the stream is already done.
    await reader.cancel().catch(() => { /* ignore cancel errors */ })
    reader.releaseLock()
  }
}
