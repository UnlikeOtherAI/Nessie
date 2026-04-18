/**
 * Simple global hook registry for plugin hooks.
 * Plugins register handlers for named events; the registry runs them on demand.
 */

import type {
  BeforeToolCallEvent, BeforeToolCallResult, BeforeToolCallContext,
  AfterToolCallEvent, AfterToolCallContext,
} from './hook-types.js'

type HookHandler = (event: unknown, context: unknown) => unknown

const handlers: Map<string, HookHandler[]> = new Map()

/**
 * Clear all registered handlers. Exported for testing.
 */
export function clearHooks(): void {
  handlers.clear()
}

/**
 * Register a handler for the given event name.
 * @param event Event name, e.g. 'before_tool_call'
 * @param handler Function called when the event fires
 */
export function registerHook(event: string, handler: HookHandler): void {
  const existing = handlers.get(event) ?? []
  existing.push(handler)
  handlers.set(event, existing)
}

/**
 * Run before_tool_call hooks and return the first block result, or undefined.
 * Fail-resilient: if a hook throws, execution continues.
 */
export async function runBeforeToolCall(
  event: BeforeToolCallEvent,
  context: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
  const hookHandlers = handlers.get('before_tool_call') ?? []
  for (const handler of hookHandlers) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, context) as BeforeToolCallResult | undefined
      if (result?.block === true) {
        return result
      }
    } catch {
      // Fail-resilient: if hook throws, continue with tool execution
    }
  }
  return undefined
}

/**
 * Run after_tool_call hooks (fire-and-forget).
 * Errors are caught and logged.
 */
export function runAfterToolCall(event: AfterToolCallEvent, context: AfterToolCallContext): void {
  const hookHandlers = handlers.get('after_tool_call') ?? []
  for (const handler of hookHandlers) {
    // Fire-and-forget: do not await, catch+log errors
    // Wrap in Promise.resolve to handle both sync and async handlers,
    // and use try/catch to handle synchronous throws
    try {
      Promise.resolve(handler(event, context)).catch((err) => {
        console.error('[hook-registry] after_tool_call hook error:', err)
      })
    } catch (err) {
      console.error('[hook-registry] after_tool_call hook error:', err)
    }
  }
}