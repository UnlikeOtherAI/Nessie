/** Error that must abort the owning agent run rather than become model input. */
export class FatalToolExecutionError extends Error {
  readonly fatalToolExecution = true

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export const isFatalToolExecutionError = (
  error: unknown,
): error is FatalToolExecutionError =>
  error instanceof FatalToolExecutionError
  || (
    error instanceof Error
    && (error as Error & { fatalToolExecution?: unknown }).fatalToolExecution === true
  )

export type QueueAttempt = { attempt: number; maxAttempts: number }

export const isFinalQueueAttempt = (attempt: QueueAttempt): boolean =>
  attempt.attempt >= attempt.maxAttempts

export const shouldRetryRunWithoutTerminalizing = (
  error: unknown,
  attempt: QueueAttempt,
): boolean => isFatalToolExecutionError(error) && !isFinalQueueAttempt(attempt)
