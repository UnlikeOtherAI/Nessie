/**
 * Simple global hook registry for plugin hooks.
 * Plugins register handlers for named events; the registry runs them on demand.
 *
 * Adapted from OpenClaw plugin-sdk (https://github.com/openclaw/openclaw/pull/18810)
 */

import type {
  BeforeToolCallEvent,
  BeforeToolCallResult,
  BeforeToolCallContext,
  AfterToolCallEvent,
  AfterToolCallContext,
} from './hook-types.js'

interface HookRegistration {
  handler: (event: unknown, context: unknown) => unknown
  priority: number
}

const handlers: Map<string, HookRegistration[]> = new Map()

/**
 * Register a handler for the given event name.
 * Handlers are executed in priority order (higher priority first).
 *
 * @param event Event name, e.g. 'before_tool_call'
 * @param handler Function called when the event fires
 * @param priority Higher priority runs first (default: 0)
 */
export function registerHook(
  event: string,
  handler: (event: unknown, context: unknown) => unknown,
  priority = 0,
): void {
  const existing = handlers.get(event) ?? []
  existing.push({ handler, priority })
  handlers.set(event, existing)
}

/**
 * Clear all registered hooks (useful for testing).
 */
export function clearHooks(): void {
  handlers.clear()
}

/**
 * Run before_tool_call hooks and return the aggregated result.
 *
 * - Returns `{ block: false }` if no hooks are registered (backward compatible)
 * - If any hook returns `{ block: true, blockReason }`, execution is blocked
 * - If hooks throw, tool execution continues (fail-resilient)
 * - Params returned by hooks are merged (later hooks override earlier ones)
 */
export async function runBeforeToolCall(
  event: BeforeToolCallEvent,
  context: BeforeToolCallContext,
): Promise<{ blocked: boolean; blockReason?: string; params: Record<string, unknown> }> {
  const registrations = (handlers.get('before_tool_call') ?? [])
    .sort((a: HookRegistration, b: HookRegistration) => b.priority - a.priority)

  if (registrations.length === 0) {
    return { blocked: false, params: event.params }
  }

  let blocked = false
  let blockReason: string | undefined
  let params = event.params

  for (const { handler } of registrations) {
    try {
      const result = await handler(event, context) as BeforeToolCallResult | undefined
      if (!result) continue

      if (result.blocked === true) {
        blocked = true
        blockReason = result.blockReason ?? 'Tool call blocked by plugin hook'
        break
      }

      // Merge params if returned (allow hooks to modify params)
      if (result.params) {
        params = { ...params, ...result.params }
      }
    } catch (err) {
      // Fail-resilient: if hook throws, continue with tool execution
      console.warn(
        '[hook-registry] before_tool_call hook threw:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { blocked, blockReason, params }
}

/**
 * Run after_tool_call hooks (fire-and-forget).
 * Errors are caught and logged but do not propagate.
 */
export function runAfterToolCall(event: AfterToolCallEvent, context: AfterToolCallContext): void {
  const registrations = handlers.get('after_tool_call') ?? []

  for (const { handler } of registrations) {
    try {
      // Fire-and-forget: do not await, catch+log errors
      const result = handler(event, context)
      if (result && typeof result === 'object' && 'then' in result) {
        ;(result as Promise<unknown>).catch((err) => {
          console.error('[hook-registry] after_tool_call hook error:', err)
        })
      }
    } catch (err) {
      console.error('[hook-registry] after_tool_call hook error:', err)
    }
  }
}
