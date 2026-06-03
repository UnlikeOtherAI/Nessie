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
}
