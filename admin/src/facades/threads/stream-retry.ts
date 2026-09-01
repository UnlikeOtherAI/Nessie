// Reconnect policy for the thread SSE stream. Deliberately React-free and pure
// so "does a 500 retry and a 403 stop?" is answerable without a fake DOM.
//
// The bug this replaces: the loop `break`ed on any non-OK response, so one 401
// during token rotation or one transient 5xx killed the stream for the rest of
// the component's mount — no thinking bubbles, no streaming reply text — while
// replies still arrived over the WebSocket refetch path, which reads as a
// broken feature rather than a dropped connection.

export const STREAM_RETRY_BASE_MS = 1_000
export const STREAM_RETRY_MAX_MS = 30_000

/**
 * Is this response terminal for this viewer on this thread?
 *
 * Only two statuses are: 403 (the viewer may not read this thread) and 404 (it
 * does not exist). Reconnecting cannot fix either. Everything else — 401, 429,
 * any 5xx, a proxy hiccup — is transient by nature.
 */
export const isTerminalStreamStatus = (status: number): boolean =>
  status === 403 || status === 404

export type StreamAttemptOutcome =
  // Established. Whether the drain then ended cleanly or died mid-stream, the
  // connection worked, so the next failure starts its backoff from scratch.
  | 'connected'
  // Transient: retry with backoff.
  | 'failed'
  // Give up for this mount.
  | 'terminal'

export const classifyStreamResponse = (response: {
  body: unknown
  ok: boolean
  status: number
}): StreamAttemptOutcome => {
  if (isTerminalStreamStatus(response.status)) {
    return 'terminal'
  }
  // A bodyless 200 is as useless as a 500 and just as likely to be a one-off.
  return response.ok && response.body ? 'connected' : 'failed'
}

/**
 * Delay before reconnect attempt `attempt` (0 = the first retry after a
 * connection that was established or refused).
 *
 * Equal jitter: half the window is the exponential backoff, half is random, so
 * many tabs recovering from one API restart spread out instead of stampeding.
 */
export const streamRetryDelayMs = (
  attempt: number,
  random: number = Math.random(),
): number => {
  const exponential = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** attempt)
  return Math.round(exponential / 2 + random * (exponential / 2))
}

interface StreamConnectionLoopOptions {
  // One connect-and-drain cycle. A throw is treated as a transient failure.
  attempt: () => Promise<StreamAttemptOutcome>
  isCancelled: () => boolean
  random?: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * Keep one SSE connection alive until the caller cancels or the thread turns
 * out to be unreachable for this viewer. Every other outcome reconnects with a
 * bounded exponential backoff that resets on each established connection.
 */
export const runStreamConnectionLoop = async (
  options: StreamConnectionLoopOptions,
): Promise<void> => {
  let retryAttempt = 0

  while (!options.isCancelled()) {
    let outcome: StreamAttemptOutcome
    try {
      outcome = await options.attempt()
    } catch {
      outcome = 'failed'
    }

    if (outcome === 'terminal' || options.isCancelled()) {
      return
    }

    if (outcome === 'connected') {
      retryAttempt = 0
    }

    await options.sleep(streamRetryDelayMs(retryAttempt, options.random?.()))
    retryAttempt += 1
  }
}
