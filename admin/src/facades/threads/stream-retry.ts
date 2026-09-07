// The client's one reconnect policy. Deliberately React-free and pure so "does
// a 500 retry and a 403 stop?" is answerable without a fake DOM.
//
// Three transports share it rather than each keeping a ladder of its own: the
// per-thread SSE stream (`./hooks.ts`), the shared `/api/events/stream`
// (`../realtime/event-stream.ts`) and the activity WebSocket
// (`../agents/activity-socket.ts`). A second copy of a backoff schedule is a
// second answer to "how does a fleet come back after a drain", which is the
// question this file exists to answer once.
//
// The bug this replaces: the loop `break`ed on any non-OK response, so one 401
// during token rotation or one transient 5xx killed the stream for the rest of
// the component's mount — no thinking bubbles, no streaming reply text — while
// replies still arrived over the WebSocket refetch path, which reads as a
// broken feature rather than a dropped connection.

export const STREAM_RETRY_BASE_MS = 1_000
export const STREAM_RETRY_MAX_MS = 30_000

/**
 * How long one connect-and-drain cycle has to last before it counts as a
 * success — that is, before it is allowed to put the backoff ladder back on
 * its bottom rung.
 *
 * A socket that connects and dies immediately did no useful work, and the old
 * rule (any established connection resets) turned that into a hammer: with N
 * replicas, draining one hands its clients to the survivors at once, and if the
 * survivor sheds them too, every client is back at the 0.5–1 s rung forever.
 * Autoscaling makes a drain routine rather than exceptional, so this fires on
 * every scale-in and every deploy, not just in an incident.
 *
 * Five seconds, for three reasons that are all facts about this code:
 *
 * - It has to be comfortably longer than a connect handshake on a bad network
 *   plus the server's first write (both SSE routes write their preamble
 *   immediately), or a healthy connection on a slow phone would be misjudged.
 * - It has to be shorter than the server's 15 s SSE keepalive
 *   (`api/src/routes/events.ts`, `api/src/routes/thread-stream.ts`), so a
 *   stream that is genuinely serving is credited without waiting for a
 *   keepalive to prove it.
 * - It has to exceed the first few rungs of the ladder — the first three waits
 *   total 3.5–7 s — so a client that is churning cannot alternate
 *   escalate/reset and sit near the floor by luck.
 *
 * What is measured is the whole cycle, not the socket's lifetime alone: the
 * loop times `attempt()` end to end. That is deliberate. The thing worth
 * suppressing is a client *spinning*, and a cycle that turns over in under five
 * seconds is spinning whether the time went on a slow handshake or a short
 * stream. Counting the handshake can only make the loop more patient, never
 * less.
 */
export const STREAM_HEALTHY_CONNECTION_MS = 5_000

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
  // The response was a readable stream. Whether that was worth anything is a
  // question about how long the cycle then lasted, which the status code
  // cannot answer — so the loop, not the classifier, decides whether it resets
  // the backoff.
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
 * Equal jitter: the delay is drawn uniformly from `[window / 2, window]`, where
 * `window` is the exponential backoff, doubling per attempt up to
 * `STREAM_RETRY_MAX_MS`.
 *
 * What that spread guarantees, stated so nobody over-claims it:
 *
 * - **No instant every waiter agrees on.** The draw is continuous across a
 *   window half the backoff wide — 500 ms at the first retry, 15 s at the cap —
 *   so N clients cut loose by the same drain at the same millisecond arrive
 *   spread across it instead of together. A constant here, even a large one,
 *   would be a synchronised discharge rather than a spread; this program has
 *   already been bitten once by a ceiling every waiter shared, and the fix
 *   there was the same one: draw it, never fix it.
 * - **The spread widens with the ladder.** Because the random half is a
 *   fraction of a doubling window, a survivor that sheds the herd again meets
 *   it spread over twice the interval, not the same burst twice.
 * - **A floor that rises monotonically.** Escalation is guaranteed, not
 *   probabilistic: attempt `n` never waits less than `2ⁿ × base / 2`. That is
 *   what makes the "connections under five seconds do not reset" rule bite;
 *   full jitter would let an unlucky client keep drawing near zero.
 *
 * What it does *not* guarantee is a bound on the instantaneous reconnect rate:
 * N clients over a 500 ms window is still 2N per second. The spread buys the
 * escalation time to take effect; it does not replace it.
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
  // Injectable only so tests can drive the five-second rule without waiting.
  now?: () => number
  random?: () => number
  sleep: (ms: number) => Promise<void>
}

/**
 * Keep one SSE connection alive until the caller cancels or the thread turns
 * out to be unreachable for this viewer. Every other outcome reconnects with a
 * bounded exponential backoff.
 *
 * The ladder resets only for a cycle that both connected *and* lasted at least
 * `STREAM_HEALTHY_CONNECTION_MS`. The timing lives here rather than in the
 * callers so neither of the two can forget it and quietly reintroduce the
 * lockstep retry.
 */
export const runStreamConnectionLoop = async (
  options: StreamConnectionLoopOptions,
): Promise<void> => {
  const now = options.now ?? Date.now
  let retryAttempt = 0

  while (!options.isCancelled()) {
    const startedAt = now()
    let outcome: StreamAttemptOutcome
    try {
      outcome = await options.attempt()
    } catch {
      outcome = 'failed'
    }

    if (outcome === 'terminal' || options.isCancelled()) {
      return
    }

    // A connection that lived less than the healthy window is a failure, not a
    // success: it did no work, and treating it as one is what let a drained
    // replica's clients retry in lockstep against the survivors.
    if (outcome === 'connected' && now() - startedAt >= STREAM_HEALTHY_CONNECTION_MS) {
      retryAttempt = 0
    }

    await options.sleep(streamRetryDelayMs(retryAttempt, options.random?.()))
    retryAttempt += 1
  }
}
