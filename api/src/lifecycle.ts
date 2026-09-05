/**
 * Graceful shutdown for the API process.
 *
 * Split out of `index.ts` so the entrypoint stays wiring and every file stays
 * under the 500-line cap (AGENTS.md), and so the drain itself is callable from
 * a test without installing real signal handlers.
 *
 * Node's default `SIGTERM` behaviour is to exit immediately. On a replica that
 * means in-flight requests reset mid-transaction, SSE and WebSocket clients get
 * no close frame (so they reconnect on their full backoff rather than at once),
 * and the pools plus the dedicated LISTEN client are dropped rather than
 * returned. With one replica that is a restart; with N behind a load balancer
 * it is a share of every deploy's traffic.
 */

import type { FastifyInstance } from 'fastify'

/** The slice of the realtime hub a drain needs. */
export type DrainableRealtimeHub = {
  closeLiveConnections: () => void
}

// Process-wide, because readiness has to answer for the process, not for one
// route instance: `/api/health/ready` reads it (`routes/health.ts`) so the load
// balancer stops sending new work the moment the signal lands, while the
// requests already in flight finish.
let draining = false

export const isDraining = (): boolean => draining

/**
 * Flip readiness to "going away" without closing anything yet.
 *
 * Exported separately from `drainApiServer` because an orchestrator that polls
 * readiness needs a window between "stop routing to me" and "sockets closed";
 * how long that window is belongs to the deployment, not to this process.
 */
export const beginDraining = (): void => {
  draining = true
}

/**
 * Drain and close, in the only order that terminates:
 *
 * 1. mark draining, so readiness answers 503 for anything that probes during
 *    the drain;
 * 2. end every live SSE stream and close every WebSocket with 1012 — Fastify
 *    will not do this (`forceCloseConnections` defaults to `'idle'`, which
 *    leaves in-flight requests alone, and an open stream is an in-flight
 *    request), so `app.close()` would otherwise wait for streams that only end
 *    when the client goes away;
 * 3. `app.close()`, which stops accepting and runs the registered `onClose`
 *    hooks — hub close (LISTEN client + pool), Prisma disconnect, the
 *    maintenance timers and, in local mode, the embedded worker.
 *
 * Returns once every hook has settled. The caller owns the exit code and the
 * deadline.
 */
export const drainApiServer = async (input: {
  app: FastifyInstance
  hub: DrainableRealtimeHub
}): Promise<void> => {
  beginDraining()
  input.hub.closeLiveConnections()
  await input.app.close()
}

export type ShutdownHandlerOptions = {
  app: FastifyInstance
  hub: DrainableRealtimeHub
  /**
   * Hard ceiling on the whole drain (`NESSIE_SHUTDOWN_TIMEOUT_MS`, default
   * 25 s). A drain that has not finished by then exits 1 rather than waiting
   * for the orchestrator's SIGKILL, so a wedged shutdown is visible as a
   * non-zero exit instead of a silent kill.
   */
  timeoutMs: number
  exit?: (code: number) => never
  log?: (message: string, error?: unknown) => void
}

const defaultExit = (code: number): never => process.exit(code)

const FALLBACK_SHUTDOWN_TIMEOUT_MS = 25_000

/**
 * A non-positive or non-finite deadline is worse than no deadline at all:
 * `setTimeout(fn, undefined)` fires on the next tick, which turns every
 * `SIGTERM` into an instant `exit(1)` with nothing drained. Observed for real
 * against a stale `@nessie/config` build, where `config.shutdownTimeoutMs` came
 * back `undefined` and the process died 67 ms after the signal. Fall back and
 * say so, rather than letting a bad number produce the worst behaviour.
 */
const resolveTimeoutMs = (
  timeoutMs: number,
  log: (message: string) => void,
): number => {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs
  }

  log(
    `shutdown timeout ${String(timeoutMs)} is not a positive number; `
      + `falling back to ${FALLBACK_SHUTDOWN_TIMEOUT_MS}ms`,
  )
  return FALLBACK_SHUTDOWN_TIMEOUT_MS
}

/**
 * Run one drain, whichever signal arrives, and exit.
 *
 * Exported for the test that drives it without `process.once`; production goes
 * through `installApiShutdownHandlers`.
 */
export const runShutdown = async (
  signal: string,
  options: ShutdownHandlerOptions,
): Promise<void> => {
  const exit = options.exit ?? defaultExit
  const log = options.log ?? ((message: string, error?: unknown) => {
    if (error) {
      console.error(`[api] ${message}`, error)
      return
    }
    console.log(`[api] ${message}`)
  })

  const timeoutMs = resolveTimeoutMs(options.timeoutMs, log)
  const deadline = setTimeout(() => {
    log(`shutdown did not complete within ${timeoutMs}ms; exiting`)
    exit(1)
  }, timeoutMs)

  try {
    log(`${signal} received; draining`)
    await drainApiServer({ app: options.app, hub: options.hub })
    clearTimeout(deadline)
    log('drain complete')
    exit(0)
  } catch (error) {
    clearTimeout(deadline)
    log('drain failed', error)
    exit(1)
  }
}

/**
 * Wire `SIGTERM`/`SIGINT` to one drain.
 *
 * `process.once` (not `on`) so a second signal from an impatient operator falls
 * through to Node's default and kills the process outright rather than starting
 * a second drain over the first. Install this only when the API is the main
 * module — mirroring the worker's `standalone` guard — so an embedder that
 * hosts `buildApp` keeps owning its own signals.
 */
export const installApiShutdownHandlers = (options: ShutdownHandlerOptions): void => {
  process.once('SIGTERM', () => {
    void runShutdown('SIGTERM', options)
  })
  process.once('SIGINT', () => {
    void runShutdown('SIGINT', options)
  })
}
