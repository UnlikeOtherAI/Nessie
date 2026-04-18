import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerHook, runBeforeToolCall, runAfterToolCall, clearHooks } from './hook-registry.js'

describe('hook-registry', () => {
  beforeEach(() => {
    clearHooks()
  })

  it('runBeforeToolCall returns undefined when no hooks registered', async () => {
    const result = await runBeforeToolCall({ toolName: 'Bash', params: {} }, { toolName: 'Bash' })
    expect(result).toBeUndefined()
  })

  it('runBeforeToolCall returns block result when hook blocks', async () => {
    registerHook('before_tool_call', () => ({ block: true, blockReason: 'Not allowed' }))
    const result = await runBeforeToolCall({ toolName: 'Bash', params: {} }, { toolName: 'Bash' })
    expect(result).toEqual({ block: true, blockReason: 'Not allowed' })
  })

  it('runBeforeToolCall returns undefined when hook allows', async () => {
    registerHook('before_tool_call', () => ({ block: false }))
    const result = await runBeforeToolCall({ toolName: 'Bash', params: {} }, { toolName: 'Bash' })
    expect(result).toBeUndefined()
  })

  it('runBeforeToolCall is fail-resilient when hook throws', async () => {
    registerHook('before_tool_call', () => { throw new Error('Hook error') })
    registerHook('before_tool_call', () => ({ block: true, blockReason: 'Blocked by second' }))
    const result = await runBeforeToolCall({ toolName: 'Bash', params: {} }, { toolName: 'Bash' })
    // First hook throws, second hook runs and blocks
    expect(result).toEqual({ block: true, blockReason: 'Blocked by second' })
  })

  it('runAfterToolCall fires handlers without blocking', () => {
    let called = false
    registerHook('after_tool_call', () => { called = true })
    runAfterToolCall({ toolName: 'Bash', params: {}, result: { data: 'ok' } }, { toolName: 'Bash' })
    // Fire-and-forget: handler runs async, give it a tick
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(called).toBe(true)
        resolve()
      }, 10)
    })
  })

  it('runAfterToolCall catches and logs handler errors', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerHook('after_tool_call', () => { throw new Error('after hook error') })
    runAfterToolCall({ toolName: 'Bash', params: {} }, { toolName: 'Bash' })
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(consoleSpy).toHaveBeenCalled()
        consoleSpy.mockRestore()
        resolve()
      }, 10)
    })
  })
})