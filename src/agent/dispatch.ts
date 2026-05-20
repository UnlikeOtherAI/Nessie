/**
 * src/agent/dispatch.ts — Inference dispatch with multi-backend failover.
 *
 * Wraps LlmClient.chat() calls with a failover loop across configured
 * backend URLs. When backends list is empty, delegates to normal single-backend
 * behavior with no overhead.
 */

import type { LlmClient } from '../llm/client.js'
import { AgentError, AgentErrorCode, formatAgentError } from './errors.js'

export interface DispatchOptions {
  /** Fallback backend URLs to try in order. Empty = single-backend mode. */
  backends: string[]
  /** Timeout per backend attempt in ms. Default: 60_000. */
  timeoutMs?: number
  /** Maximum tokens to generate. Default: 1024. */
  maxTokens?: number
}

export interface DispatchResult {
  output: string
  /** The backend URL that returned the successful response. */
  backendUsed: string
}

/**
 * Classify whether an inference error is retryable on another backend.
 * Covers: rate-limit, 503/unavailable, timeouts, connection resets, network failures.
 *
 * Node `fetch` surfaces network errors as `TypeError: fetch failed` with the real
 * code surfaced in `err.cause.code` (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, etc.).
 * HTTP 500/502/504 are also retryable — the next backend may handle them.
 */
export function isRetryableInferenceError(err: Error): boolean {
  const msg = err.message.toLowerCase()

  // HTTP status codes embedded in error messages
  if (/\b(429|500|502|504)\b/.test(msg)) return true

  // Node.js network error codes surfaced in err.cause.code
  const code = (err as unknown as { cause?: { code?: string } }).cause?.code
  if (code) {
    const RETRYABLE_CODES = new Set([
      'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
      'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH',
      'EHOSTUNREACH', 'EPIPE', 'ESHUTDOWN',
    ])
    if (RETRYABLE_CODES.has(code)) return true
  }

  // Keyword-based fallbacks
  return (
    msg.includes('rate limit') ||
    msg.includes('service unavailable') ||
    msg.includes('quota exhausted') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    (err as unknown as { status?: number }).status === 429 ||
    (err as unknown as { status?: number }).status === 503
  )
}

/**
 * Dispatch an inference request with failover across configured backends.
 *
 * When `backends` is empty, delegates to the LLM client's built-in behavior
 * (no added overhead). When backends are configured, tries them in order and
 * falls back on retryable errors (rate-limit, 503, timeout, etc.).
 *
 * @param llm - The LLM client to use for inference
 * @param messages - Chat message array (readonly is fine — array is not mutated)
 * @param options - Dispatch options including fallback backend URLs
 * @returns The model's output text and which backend handled it
 * @throws AgentError with code ALL_BACKENDS_EXHAUSTED if all backends fail
 */
export async function dispatchWithFailover(
  llm: LlmClient,
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[],
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { backends, timeoutMs = 60_000, maxTokens = 1024 } = options
  // Mutable copy for LLM client calls
  const msgs = messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>

  // Single-backend mode — no failover overhead
  if (backends.length === 0) {
    const output = await withTimeout(llm.chat(msgs, { maxTokens }), timeoutMs)
    return { output, backendUsed: 'primary' }
  }

  const errors: Error[] = []

  // Try primary first via normal chat
  try {
    const output = await withTimeout(llm.chat(msgs, { maxTokens }), timeoutMs)
    return { output, backendUsed: 'primary' }
  } catch (primaryErr) {
    const isRetryable = isRetryableInferenceError(primaryErr as Error)
    if (!isRetryable) {
      throw primaryErr
    }
    // Primary failed with a retryable error — try backends
    console.warn(`[dispatch] Primary backend failed (${formatAgentError(primaryErr)}), trying fallback backends...`)
    errors.push(primaryErr as Error)
  }

  // Fallback loop
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i]!
    try {
      const output = await withTimeout(
        llm.chat(msgs, { baseUrl: backend, maxTokens } as { baseUrl?: string; maxTokens?: number }),
        timeoutMs,
      )
      console.warn(`[dispatch] Backend failover: primary failed, using backup ${backend}`)
      return { output, backendUsed: backend }
    } catch (err) {
      errors.push(err as Error)
      const isRetryable = isRetryableInferenceError(err as Error)
      if (!isRetryable || i === backends.length - 1) {
        break
      }
      console.warn(`[dispatch] Backend ${backend} failed (${formatAgentError(err)}), trying next...`)
    }
  }

  throw new AgentError(
    `All ${backends.length + 1} backends exhausted (primary + ${backends.length} fallback)`,
    {
      code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED,
      cause: errors,
    },
  )
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      // Abort the in-flight fetch to release the socket back to the pool
      controller.abort()
      reject(new Error(`Inference timed out after ${ms}ms`))
    }, ms)
  })

  // Wire the internal controller's signal into the promise so fetch aborts on timeout
  const promiseWithSignal = new Promise<T>((resolve, reject) => {
    promise
      .then((v) => { clearTimeout(timeoutId); resolve(v) })
      .catch((e) => { clearTimeout(timeoutId); reject(e) })
  })

  try {
    return await Promise.race([promiseWithSignal, timeout])
  } finally {
    if (!timedOut) clearTimeout(timeoutId)
  }
}