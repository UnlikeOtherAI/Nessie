/**
 * src/agent/dispatch.test.ts — Tests for inference dispatch with multi-backend failover.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchWithFailover, isRetryableInferenceError } from './dispatch.js'
import { AgentError, AgentErrorCode } from './errors.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

type MockLlmCall = { messages: unknown; options?: { baseUrl?: string } }

function createMockLlm(responses: Array<{ ok: true; value: string } | { ok: false; error: Error }>): {
  calls: MockLlmCall[]
  chat: (msgs: unknown, opts?: { baseUrl?: string }) => Promise<string>
  close: () => void
} {
  const calls: MockLlmCall[] = []
  let responseIndex = 0
  return {
    calls,
    chat: async (messages: unknown, options?: { baseUrl?: string }) => {
      calls.push({ messages, options })
      const result = responses[responseIndex++]
      if (!result) throw new Error('No more responses configured')
      if (!result.ok) throw result.error
      return result.value
    },
    close() {},
  }
}

// ─── isRetryableInferenceError ───────────────────────────────────────────────

test('isRetryableInferenceError: rate limit message → true', () => {
  assert.equal(isRetryableInferenceError(new Error('rate limit exceeded')), true)
})

test('isRetryableInferenceError: 429 status → true', () => {
  const err = new Error('too many requests') as Error & { status: number }
  err.status = 429
  assert.equal(isRetryableInferenceError(err), true)
})

test('isRetryableInferenceError: 503 service unavailable → true', () => {
  const err = new Error('service unavailable') as Error & { status: number }
  err.status = 503
  assert.equal(isRetryableInferenceError(err), true)
})

test('isRetryableInferenceError: timeout / etimedout → true', () => {
  assert.equal(isRetryableInferenceError(new Error('ETIMEDOUT')), true)
  assert.equal(isRetryableInferenceError(new Error('ECONNRESET')), true)
})

test('isRetryableInferenceError: quota exhausted → true', () => {
  assert.equal(isRetryableInferenceError(new Error('quota exhausted')), true)
})

test('isRetryableInferenceError: non-retryable error → false', () => {
  assert.equal(isRetryableInferenceError(new Error('invalid api key')), false)
  assert.equal(isRetryableInferenceError(new Error('model not found')), false)
  assert.equal(isRetryableInferenceError(new Error('bad request')), false)
})

// ─── dispatchWithFailover: empty backends ─────────────────────────────────────

test('empty backends: delegates to normal LLM client, no failover overhead', async () => {
  const llm = createMockLlm([{ ok: true, value: 'normal response' }])
  const messages = [{ role: 'user', content: 'hello' }] as const

  const result = await dispatchWithFailover(llm, messages, { backends: [] })

  assert.equal(result.output, 'normal response')
  assert.equal(result.backendUsed, 'primary')
  assert.equal(llm.calls.length, 1)
})

// ─── dispatchWithFailover: primary succeeds ──────────────────────────────────

test('primary succeeds: returns immediately without trying backends', async () => {
  const llm = createMockLlm([{ ok: true, value: 'primary ok' }])
  const messages = [{ role: 'user', content: 'hello' }] as const

  const result = await dispatchWithFailover(llm, messages, {
    backends: ['https://backup.example.com'],
  })

  assert.equal(result.output, 'primary ok')
  assert.equal(result.backendUsed, 'primary')
  assert.equal(llm.calls.length, 1)
})

// ─── dispatchWithFailover: primary fails, second succeeds ────────────────────

test('primary fails with retryable error: failover to second backend succeeds', async () => {
  const llm = createMockLlm([
    { ok: false, error: new Error('rate limit') },
    { ok: true, value: 'backup succeeded' },
  ])
  const messages = [{ role: 'user', content: 'hello' }] as const

  const result = await dispatchWithFailover(llm, messages, {
    backends: ['https://backup.example.com'],
  })

  assert.equal(result.output, 'backup succeeded')
  assert.equal(result.backendUsed, 'https://backup.example.com')
  assert.equal(llm.calls.length, 2)
})

// ─── dispatchWithFailover: non-retryable error ───────────────────────────────

test('non-retryable error on primary: throws immediately, no failover', async () => {
  const llm = createMockLlm([
    { ok: false, error: new Error('invalid api key') },
    { ok: true, value: 'should not reach this' },
  ])
  const messages = [{ role: 'user', content: 'hello' }] as const

  await assert.rejects(
    dispatchWithFailover(llm, messages, {
      backends: ['https://backup.example.com'],
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err instanceof AgentError, false)
      assert.equal((err as Error).message, 'invalid api key')
      return true
    },
  )

  // Second backend should never have been called
  assert.equal(llm.calls.length, 1)
})

// ─── dispatchWithFailover: all backends fail ─────────────────────────────────

test('all backends fail: throws AgentError with ALL_BACKENDS_EXHAUSTED and error chain', async () => {
  const llm = createMockLlm([
    { ok: false, error: new Error('rate limit') },
    { ok: false, error: new Error('service unavailable') },
    { ok: false, error: new Error('connection refused') },
  ])
  const messages = [{ role: 'user', content: 'hello' }] as const

  await assert.rejects(
    dispatchWithFailover(llm, messages, {
      backends: ['https://backup1.example.com', 'https://backup2.example.com'],
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentError, 'should be AgentError')
      const agentErr = err as AgentError
      assert.equal(agentErr.code, AgentErrorCode.ALL_BACKENDS_EXHAUSTED)
      const cause = agentErr.cause as Error[]
      assert.equal(cause.length, 3)
      assert.match(cause[0]!.message, /rate limit/)
      assert.match(cause[1]!.message, /service unavailable/)
      assert.match(cause[2]!.message, /connection refused/)
      return true
    },
  )

  assert.equal(llm.calls.length, 3)
})

// ─── dispatchWithFailover: rate-limit triggers failover ──────────────────────

test('rate-limit error triggers failover to next backend', async () => {
  const llm = createMockLlm([
    { ok: false, error: new Error('rate limit exceeded') },
    { ok: true, value: 'recovered via backup' },
  ])

  const result = await dispatchWithFailover(llm, [{ role: 'user', content: 'test' }], {
    backends: ['https://backup.example.com'],
  })

  assert.equal(result.output, 'recovered via backup')
  assert.equal(result.backendUsed, 'https://backup.example.com')
})

// ─── dispatchWithFailover: 503 UNAVAILABLE triggers failover ────────────────

test('503 UNAVAILABLE error triggers failover', async () => {
  const err503 = new Error('service unavailable') as Error & { status: number }
  err503.status = 503
  const llm = createMockLlm([
    { ok: false, error: err503 },
    { ok: true, value: 'backup ok' },
  ])

  const result = await dispatchWithFailover(llm, [{ role: 'user', content: 'test' }], {
    backends: ['https://backup.example.com'],
  })

  assert.equal(result.output, 'backup ok')
  assert.equal(result.backendUsed, 'https://backup.example.com')
})

// ─── dispatchWithFailover: multiple fallback backends ────────────────────────

test('first fallback fails: tries second fallback', async () => {
  const llm = createMockLlm([
    { ok: false, error: new Error('rate limit') },
    { ok: false, error: new Error('timeout') },
    { ok: true, value: 'second backup worked' },
  ])

  const result = await dispatchWithFailover(llm, [{ role: 'user', content: 'test' }], {
    backends: ['https://backup1.example.com', 'https://backup2.example.com'],
  })

  assert.equal(result.output, 'second backup worked')
  assert.equal(result.backendUsed, 'https://backup2.example.com')
  assert.equal(llm.calls.length, 3)
})

// ─── dispatchWithFailover: timeout per backend ────────────────────────────────

test('timeout per backend: both backends timeout → AgentError', async () => {
  // Simulate timeout errors: use messages that include "timed out" which is retryable
  const llm = createMockLlm([
    { ok: false, error: new Error('ETIMEDOUT connection timeout') },
    { ok: false, error: new Error('ETIMEDOUT connection timeout') },
  ])

  await assert.rejects(
    dispatchWithFailover(llm, [{ role: 'user', content: 'test' }], {
      backends: ['https://backup.example.com'],
      timeoutMs: 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentError)
      assert.equal((err as AgentError).code, AgentErrorCode.ALL_BACKENDS_EXHAUSTED)
      return true
    },
  )
})

// ─── dispatchWithFailover: passes baseUrl to backup ──────────────────────────

test('backup backend: baseUrl option is passed to LLM client', async () => {
  const llm = createMockLlm([
    { ok: false, error: new Error('rate limit') },
    { ok: true, value: 'ok' },
  ])

  await dispatchWithFailover(llm, [{ role: 'user', content: 'test' }], {
    backends: ['https://backup.example.com'],
  })

  // Second call should have the baseUrl set
  assert.equal(llm.calls[1]!.options?.baseUrl, 'https://backup.example.com')
})

// ─── AgentError structure ────────────────────────────────────────────────────

test('AgentError: has code, name, message, and cause', () => {
  const cause = [new Error('first'), new Error('second')]
  const err = new AgentError('all failed', { code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED, cause })

  assert.equal(err.name, 'AgentError')
  assert.equal(err.message, 'all failed')
  assert.equal(err.code, 'ALL_BACKENDS_EXHAUSTED')
  assert.equal((err.cause as Error[]).length, 2)
  assert.equal(err instanceof Error, true)
})