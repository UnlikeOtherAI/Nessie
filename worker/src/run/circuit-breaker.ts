export const CIRCUIT_BREAKER_THRESHOLD = 3

// `executorToolName('mcp.call')` and `executorToolName('mcp.tools')`, spelled
// out so the breaker stays free of the executor toolset's imports; a test pins
// that they agree.
const EXECUTOR_MCP_CALL_TOOL_NAME = 'executor_mcp_call'
const EXECUTOR_MCP_TOOLS_TOOL_NAME = 'executor_mcp_tools'

/**
 * What a call's failures are counted under. Every tool is its own key except
 * the executor's two generic `mcp.*` transports, which front every program the
 * machine's owner named: three failures of one browser tool must not disable a
 * different program, so a call's key names the server and the tool, and a
 * listing's names the server — Kelpie not running must not stop the run
 * listing ollama-search.
 *
 * `toolName` is the name the run offers, after any provider namespace prefix
 * (`default.`, `functions.`) has been dropped; the batch normalises it first.
 */
export const circuitBreakerKey = (toolName: string, args: Record<string, unknown>): string => {
  const { server, tool } = args
  if (toolName === EXECUTOR_MCP_CALL_TOOL_NAME) {
    return typeof server === 'string' && typeof tool === 'string'
      ? `${toolName}:${server}:${tool}`
      : toolName
  }
  if (toolName === EXECUTOR_MCP_TOOLS_TOOL_NAME) {
    return typeof server === 'string' ? `${toolName}:${server}` : toolName
  }
  return toolName
}

export class ToolCircuitBreaker {
  private _consecutiveErrors = new Map<string, number>()

  recordSuccess(toolName: string): void {
    this._consecutiveErrors.delete(toolName)
  }

  recordError(toolName: string): { tripped: boolean; count: number } {
    const count = (this._consecutiveErrors.get(toolName) ?? 0) + 1
    this._consecutiveErrors.set(toolName, count)
    return { tripped: count >= CIRCUIT_BREAKER_THRESHOLD, count }
  }

  isTripped(toolName: string): boolean {
    return (this._consecutiveErrors.get(toolName) ?? 0) >= CIRCUIT_BREAKER_THRESHOLD
  }

  trippedErrorMessage(toolName: string): string {
    return `Tool "${toolName}" disabled after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`
  }

  reset(): void {
    this._consecutiveErrors.clear()
  }

  /**
   * The counts, for a crash checkpoint. The breaker object is per-execution,
   * but the failures it counts are the run's: a run re-claimed after every
   * crash would otherwise start each execution with a clean breaker and keep
   * retrying a tool that has been failing all along.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this._consecutiveErrors)
  }

  /** Adopt a resumed run's counts, replacing whatever this breaker holds. */
  restore(counts: Record<string, number>): void {
    this._consecutiveErrors = new Map(Object.entries(counts))
  }
}
