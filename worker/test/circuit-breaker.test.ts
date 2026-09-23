import { describe, test } from 'node:test'
import assert from 'node:assert'
import { circuitBreakerKey, ToolCircuitBreaker } from '../src/run/circuit-breaker.js'
import { executorToolName } from '../src/run/executor-toolset.js'

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

describe('circuitBreakerKey', () => {
  test('keys the executor mcp transport by server and tool', () => {
    // One program's flaky tool must not disable every other program the
    // machine's owner named behind the same transport.
    assert.strictEqual(
      circuitBreakerKey('executor_mcp_call', { arguments: {}, server: 'kelpie', tool: 'wait_for_element' }),
      'executor_mcp_call:kelpie:wait_for_element',
    )
    assert.notStrictEqual(
      circuitBreakerKey('executor_mcp_call', { server: 'kelpie', tool: 'wait_for_element' }),
      circuitBreakerKey('executor_mcp_call', { server: 'coding-sessions', tool: 'start' }),
    )
  })

  test('keys an executor listing by its server', () => {
    // Kelpie not running must not stop the run listing another program.
    assert.strictEqual(circuitBreakerKey('executor_mcp_tools', { server: 'kelpie' }), 'executor_mcp_tools:kelpie')
    assert.strictEqual(
      circuitBreakerKey('executor_mcp_tools', { server: 'kelpie', tool: 'navigate' }),
      'executor_mcp_tools:kelpie',
      'one program is one listing, whichever tool is asked about',
    )
    assert.strictEqual(circuitBreakerKey('executor_mcp_tools', {}), 'executor_mcp_tools')
    assert.strictEqual(executorToolName('mcp.tools'), 'executor_mcp_tools')
  })

  test('every other tool keeps its own name, whatever its arguments', () => {
    assert.strictEqual(circuitBreakerKey('bash', { server: 'kelpie', tool: 'x' }), 'bash')
  })

  test('an mcp call without a readable server and tool falls back to the tool name', () => {
    assert.strictEqual(circuitBreakerKey('executor_mcp_call', {}), 'executor_mcp_call')
    assert.strictEqual(circuitBreakerKey('executor_mcp_call', { server: 3, tool: 'x' }), 'executor_mcp_call')
  })

  test('the spelled-out transport name is the executor toolset’s', () => {
    assert.strictEqual(executorToolName('mcp.call'), 'executor_mcp_call')
    assert.notStrictEqual(
      circuitBreakerKey(executorToolName('mcp.call'), { server: 'kelpie', tool: 'navigate' }),
      executorToolName('mcp.call'),
    )
  })

  test('three failures of one server tool disable that tool and nothing else', () => {
    const cb = new ToolCircuitBreaker()
    const flaky = circuitBreakerKey('executor_mcp_call', { server: 'kelpie', tool: 'wait_for_element' })
    for (let failure = 0; failure < 3; failure += 1) cb.recordError(flaky)
    assert.strictEqual(cb.isTripped(flaky), true)
    assert.strictEqual(
      cb.isTripped(circuitBreakerKey('executor_mcp_call', { server: 'kelpie', tool: 'navigate' })),
      false,
    )
    assert.strictEqual(
      cb.isTripped(circuitBreakerKey('executor_mcp_call', { server: 'coding-sessions', tool: 'start' })),
      false,
    )
  })
})
