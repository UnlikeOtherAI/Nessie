/**
 * src/agent/dispatch.ts — Inference dispatch with multi-backend failover.
 *
 * Wraps LlmClient.chat() calls with a failover loop across configured
 * backend URLs. When backends list is empty, delegates to normal single-backend
 * behavior with no overhead.
 */

import type { LlmClient } from '../llm/client.js'
import { AgentError, AgentErrorCode } from './errors.js'

export interface DispatchOptions {
  /** Fallback backend URLs to try in order. Empty = single-backend mode. */
  backends: string[]
  /** Timeout per backend attempt in ms. Default: 60_000. */
  timeoutMs?: number
}

export interface DispatchResult {
  output: string
  /** The backend URL that returned the successful response. */
  backendUsed: string
}

/**
 * Classify whether an inference error is retryable on another backend.
 * Covers: rate-limit, 503/unavailable, timeouts, connection resets.
 */
export function isRetryableInferenceError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
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
  const { backends, timeoutMs = 60_000 } = options
  // Mutable copy for LLM client calls
  const msgs = messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>

  // Single-backend mode — no failover overhead
  if (backends.length === 0) {
    const output = await withTimeout(llm.chat(msgs), timeoutMs)
    return { output, backendUsed: 'primary' }
  }

  const errors: Error[] = []

  // Try primary first via normal chat
  try {
    const output = await withTimeout(llm.chat(msgs), timeoutMs)
    return { output, backendUsed: 'primary' }
  } catch (primaryErr) {
    const isRetryable = isRetryableInferenceError(primaryErr as Error)
    if (!isRetryable) {
      throw primaryErr
    }
    // Primary failed with a retryable error — try backends
    console.warn(`[dispatch] Primary backend failed (${(primaryErr as Error).message}), trying fallback backends...`)
    errors.push(primaryErr as Error)
  }

  // Fallback loop
  for (let i = 0; i < backends.length; i++) {
    const backend = backends[i]!
    try {
      const output = await withTimeout(
        llm.chat(msgs, { baseUrl: backend } as { baseUrl?: string }),
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
      console.warn(`[dispatch] Backend ${backend} failed (${(err as Error).message}), trying next...`)
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
  let timeoutId: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Inference timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timeoutId!)
  }
}