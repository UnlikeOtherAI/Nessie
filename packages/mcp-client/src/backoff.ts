/**
 * Exponential backoff with full jitter, capped at a configurable ceiling.
 *
 * Intentionally simple — no event loop, no internal retry; the caller drives
 * each attempt and asks for the next delay. Returns `null` when the budget is
 * exhausted so the caller has to surface a typed transport error and stop —
 * we never silently keep retrying a dead connection.
 */

export type BackoffConfig = {
  /** Initial delay before the first retry attempt, in milliseconds. */
  initialMs?: number
  /** Hard ceiling for any single delay, in milliseconds. */
  maxMs?: number
  /** Multiplicative factor applied each attempt. */
  factor?: number
  /** Maximum number of retries before `nextDelay` returns `null`. */
  maxAttempts?: number
}

const DEFAULTS: Required<BackoffConfig> = {
  initialMs: 200,
  maxMs: 30_000,
  factor: 2,
  maxAttempts: 6,
}

export class Backoff {
  private attempts = 0

  private readonly cfg: Required<BackoffConfig>

  private readonly random: () => number

  constructor(cfg: BackoffConfig = {}, random: () => number = Math.random) {
    this.cfg = { ...DEFAULTS, ...cfg }
    this.random = random
  }

  /** Resets attempt count back to zero — call after a successful reconnect. */
  reset(): void {
    this.attempts = 0
  }

  get attemptCount(): number {
    return this.attempts
  }

  /**
   * Returns the next delay in milliseconds with full jitter, or `null` when
   * the configured `maxAttempts` budget is exhausted.
   */
  nextDelay(): number | null {
    if (this.attempts >= this.cfg.maxAttempts) return null
    const exp = this.cfg.initialMs * (this.cfg.factor ** this.attempts)
    const capped = Math.min(this.cfg.maxMs, exp)
    this.attempts += 1
    return Math.floor(this.random() * capped)
  }
}

/** Sleep helper that honours an optional `AbortSignal`. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
