export const CIRCUIT_BREAKER_THRESHOLD = 3

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
