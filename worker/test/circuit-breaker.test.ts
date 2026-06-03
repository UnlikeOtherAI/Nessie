import { describe, test } from 'node:test'
import assert from 'node:assert'
import { ToolCircuitBreaker } from '../src/run/circuit-breaker.js'

describe('ToolCircuitBreaker', () => {
  test('starts with no errors recorded', () => {
    const cb = new ToolCircuitBreaker()
    assert.strictEqual(cb.isTripped('bash'), false)
    assert.strictEqual(cb.isTripped('web_fetch'), false)
  })

  test('records success resets error count', () => {
    const cb = new ToolCircuitBreaker()
    cb.recordError('bash')
    cb.recordError('bash')
    cb.recordSuccess('bash')
    assert.strictEqual(cb.isTripped('bash'), false)
  })

  test('trips after 3 consecutive errors', () => {
    const cb = new ToolCircuitBreaker()
    const r1 = cb.recordError('bash')
    assert.strictEqual(r1.tripped, false)
    assert.strictEqual(r1.count, 1)

    const r2 = cb.recordError('bash')
    assert.strictEqual(r2.tripped, false)
    assert.strictEqual(r2.count, 2)

    const r3 = cb.recordError('bash')
    assert.strictEqual(r3.tripped, true)
    assert.strictEqual(r3.count, 3)

    assert.strictEqual(cb.isTripped('bash'), true)
  })

  test('tracks errors per tool independently', () => {
    const cb = new ToolCircuitBreaker()
    cb.recordError('bash')
    cb.recordError('bash')
    cb.recordError('web_fetch')
    assert.strictEqual(cb.isTripped('bash'), false)
    assert.strictEqual(cb.isTripped('web_fetch'), false)

    cb.recordError('bash')
    assert.strictEqual(cb.isTripped('bash'), true)
    assert.strictEqual(cb.isTripped('web_fetch'), false)
  })

  test('reset clears all state', () => {
    const cb = new ToolCircuitBreaker()
    cb.recordError('bash')
    cb.recordError('bash')
    cb.recordError('bash')
    assert.strictEqual(cb.isTripped('bash'), true)

    cb.reset()
    assert.strictEqual(cb.isTripped('bash'), false)
  })

  test('tripped error message includes tool name and threshold', () => {
    const cb = new ToolCircuitBreaker()
    cb.recordError('file_read')
    cb.recordError('file_read')
    cb.recordError('file_read')
    const msg = cb.trippedErrorMessage('file_read')
    assert.ok(msg.includes('file_read'))
    assert.ok(msg.includes('3'))
  })
})
