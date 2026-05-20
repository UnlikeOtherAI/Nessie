/**
 * src/agent/errors.test.ts — Tests for formatAgentError and AgentError types.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentError, AgentErrorCode, formatAgentError } from './errors.js'

// ─── formatAgentError: basic cases ──────────────────────────────────────────

test('formatAgentError: formats plain Error message', () => {
  const err = new Error('something broke')
  assert.equal(formatAgentError(err), 'something broke')
})

test('formatAgentError: formats string directly', () => {
  assert.equal(formatAgentError('plain string error'), 'plain string error')
})

test('formatAgentError: formats number', () => {
  assert.equal(formatAgentError(42), '42')
})

test('formatAgentError: formats boolean', () => {
  assert.equal(formatAgentError(false), 'false')
})

test('formatAgentError: formats bigint', () => {
  assert.equal(formatAgentError(123n), '123')
})

test('formatAgentError: formats plain object via JSON', () => {
  assert.equal(formatAgentError({ foo: 'bar' }), '{"foo":"bar"}')
})

test('formatAgentError: formats null', () => {
  assert.equal(formatAgentError(null), '')
})

test('formatAgentError: formats undefined', () => {
  assert.equal(formatAgentError(undefined), '')
})

test('formatAgentError: uses Error.name when message is empty', () => {
  const err = new Error('')
  err.name = 'CustomError'
  assert.equal(formatAgentError(err), 'CustomError')
})

// ─── formatAgentError: .cause chain traversal ───────────────────────────────

test('formatAgentError: traverses .cause chain', () => {
  const root = new Error('root cause')
  const wrapped = new Error('wrapped error')
  ;(wrapped as Error & { cause?: unknown }).cause = root
  assert.equal(formatAgentError(wrapped), 'wrapped error | root cause')
})

test('formatAgentError: traverses nested .cause chain (3 levels)', () => {
  const deep = new Error('deep cause')
  const mid = new Error('middle error')
  ;(mid as Error & { cause?: unknown }).cause = deep
  const top = new Error('top error')
  ;(top as Error & { cause?: unknown }).cause = mid
  assert.equal(formatAgentError(top), 'top error | middle error | deep cause')
})

// ─── formatAgentError: deduplication ────────────────────────────────────────

test('formatAgentError: deduplicates repeated messages in chain', () => {
  const root = new Error('same message')
  const wrapped = new Error('same message')
  ;(wrapped as Error & { cause?: unknown }).cause = root
  assert.equal(formatAgentError(wrapped), 'same message')
})

test('formatAgentError: deduplicates partially repeated chain', () => {
  const root = new Error('shared')
  const mid = new Error('shared')
  ;(mid as Error & { cause?: unknown }).cause = root
  const top = new Error('unique top')
  ;(top as Error & { cause?: unknown }).cause = mid
  assert.equal(formatAgentError(top), 'unique top | shared')
})

// ─── formatAgentError: circular references ──────────────────────────────────

test('formatAgentError: handles circular .cause without infinite loop', () => {
  const a: Error & { cause?: unknown } = new Error('error A')
  const b: Error & { cause?: unknown } = new Error('error B')
  a.cause = b
  b.cause = a
  assert.equal(formatAgentError(a), 'error A | error B')
})

test('formatAgentError: handles self-referential .cause', () => {
  const err: Error & { cause?: unknown } = new Error('self-referential')
  err.cause = err
  assert.equal(formatAgentError(err), 'self-referential')
})

// ─── formatAgentError: string causes ──────────────────────────────────────────

test('formatAgentError: handles string .cause', () => {
  const err: Error & { cause?: unknown } = new Error('wrapper')
  err.cause = 'string cause'
  assert.equal(formatAgentError(err), 'wrapper | string cause')
})

test('formatAgentError: deduplicates string .cause equal to message', () => {
  const err: Error & { cause?: unknown } = new Error('duplicate')
  err.cause = 'duplicate'
  assert.equal(formatAgentError(err), 'duplicate')
})

// ─── formatAgentError: AgentError with Error[] cause ────────────────────────

test('formatAgentError: flattens AgentError.cause array into chain', () => {
  const cause1 = new Error('first backend failed')
  const cause2 = new Error('second backend failed')
  const err = new AgentError('all backends exhausted', {
    code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED,
    cause: [cause1, cause2],
  })
  assert.equal(formatAgentError(err), 'all backends exhausted | first backend failed | second backend failed')
})

test('formatAgentError: deduplicates across AgentError.cause array', () => {
  const cause1 = new Error('timeout')
  const cause2 = new Error('timeout')
  const err = new AgentError('all failed', {
    code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED,
    cause: [cause1, cause2],
  })
  assert.equal(formatAgentError(err), 'all failed | timeout')
})

test('formatAgentError: handles AgentError with single Error cause', () => {
  const cause = new Error('underlying problem')
  const err = new AgentError('agent failed', {
    code: AgentErrorCode.INFERENCE_FAILED,
    cause,
  })
  assert.equal(formatAgentError(err), 'agent failed | underlying problem')
})

test('formatAgentError: handles AgentError with empty cause array', () => {
  const err = new AgentError('agent failed', {
    code: AgentErrorCode.TOOL_EXECUTION_FAILED,
    cause: [],
  })
  assert.equal(formatAgentError(err), 'agent failed')
})

test('formatAgentError: handles AgentError with mixed cause array (Error + string)', () => {
  const cause1 = new Error('error cause')
  const err = new AgentError('mixed causes', {
    code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED,
    // @ts-expect-error — testing runtime resilience with non-Error in cause array
    cause: [cause1, 'string cause'],
  })
  assert.equal(formatAgentError(err), 'mixed causes | error cause | string cause')
})

test('formatAgentError: deduplicates AgentError.cause with parent message', () => {
  const cause = new Error('same as parent')
  const err = new AgentError('same as parent', {
    code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED,
    cause: [cause],
  })
  assert.equal(formatAgentError(err), 'same as parent')
})

// ─── formatAgentError: nested AgentError chains ───────────────────────────────

test('formatAgentError: handles nested AgentError with their own causes', () => {
  const deepCause = new Error('database timeout')
  const midErr = new AgentError('inference failed', {
    code: AgentErrorCode.INFERENCE_FAILED,
    cause: deepCause,
  })
  const topErr = new AgentError('all backends exhausted', {
    code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED,
    cause: [midErr, new Error('network unreachable')],
  })
  assert.equal(
    formatAgentError(topErr),
    'all backends exhausted | inference failed | database timeout | network unreachable',
  )
})

// ─── formatAgentError: complex scenarios ────────────────────────────────────

test('formatAgentError: handles Error with .cause containing AgentError', () => {
  const agentErr = new AgentError('tool execution failed', {
    code: AgentErrorCode.TOOL_EXECUTION_FAILED,
    cause: new Error('command not found'),
  })
  const wrapper = new Error('request failed')
  ;(wrapper as Error & { cause?: unknown }).cause = agentErr
  assert.equal(formatAgentError(wrapper), 'request failed | tool execution failed | command not found')
})

test('formatAgentError: handles deeply nested circular references', () => {
  const a: Error & { cause?: unknown } = new Error('A')
  const b: Error & { cause?: unknown } = new Error('B')
  const c: Error & { cause?: unknown } = new Error('C')
  a.cause = b
  b.cause = c
  c.cause = a // circular back to a
  assert.equal(formatAgentError(a), 'A | B | C')
})

// ─── AgentError structure ───────────────────────────────────────────────────

test('AgentError: has code, name, message, and cause', () => {
  const cause = [new Error('first'), new Error('second')]
  const err = new AgentError('all failed', { code: AgentErrorCode.ALL_BACKENDS_EXHAUSTED, cause })

  assert.equal(err.name, 'AgentError')
  assert.equal(err.message, 'all failed')
  assert.equal(err.code, 'ALL_BACKENDS_EXHAUSTED')
  assert.equal((err.cause as Error[]).length, 2)
  assert.equal(err instanceof Error, true)
})
