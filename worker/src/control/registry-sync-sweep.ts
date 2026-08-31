import type { PrismaClient } from '@prisma/client'

import {
  REGISTRY_MAX_PAGES,
  REGISTRY_MAX_RECORDS,
  syncRegistry,
  type SyncRegistryResult,
} from '@nessie/mcp-manage'

/**
 * Keep the Apps catalogue full without anyone running the `sync:registry` CLI.
 *
 * `/apps` is filled from the official MCP registry (~5,500 apps) by
 * `syncRegistry`, but nothing called it on a schedule: a fresh deploy showed
 * only the seeded first-party connectors until an operator ran the CLI. This is
 * the missing scheduler's decision core — the worker sweeps on an interval and
 * this function decides, cheaply and idempotently, whether a fresh walk is due.
 *
 * Why a self-gate instead of "sync on every tick": one full walk is dozens of
 * requests over several minutes. A worker restart must not kick off a fresh
 * walk every time, and a 30-minute poll must not walk the registry 48× a day.
 * So the cadence is read from the data — the last completed run — not the timer.
 * Calling this is therefore safe as often as you like.
 */

/** Re-sync the catalogue at most this often; the walk itself is bounded below. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * How long an *in-progress* run row is trusted to belong to a live walk. A walk
 * takes minutes; past this it is a zombie — the process that owned it died
 * mid-walk (a deploy replaced the container, or the request-scoped background
 * sync in the API process was killed) and its row will never complete. Without
 * a separate, short window here a zombie would block every scheduled sync for
 * the full 6h interval, which is exactly the empty-store symptom this scheduler
 * exists to prevent. Matched to the manual-trigger route's own stale window.
 */
const DEFAULT_STALE_MS = 30 * 60 * 1000

/**
 * Resolved per call (not memoised at import) so an operator can tune the cadence
 * through the environment and a test can override it through the option, without
 * either racing a module-load snapshot.
 */
const resolveIntervalMs = (override?: number): number => {
  if (typeof override === 'number' && override > 0) return override
  const fromEnv = Number(process.env.NESSIE_REGISTRY_SYNC_INTERVAL_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INTERVAL_MS
}

const resolveStaleMs = (override?: number): number => {
  if (typeof override === 'number' && override > 0) return override
  const fromEnv = Number(process.env.NESSIE_REGISTRY_SYNC_STALE_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STALE_MS
}

export type MaybeSyncRegistryOptions = {
  /** Staleness window: a run completed newer than this means "skip". */
  intervalMs?: number
  /**
   * How long an in-progress run is assumed live before it is treated as a
   * zombie the sweep may supersede. Must comfortably exceed a real walk's
   * duration, or the sweep could start a second sync on top of a healthy one.
   */
  staleMs?: number
  /** Injectable clock, so the decision is testable without waiting real time. */
  now?: () => number
  /**
   * Injectable importer, so the gate logic is testable without the network or a
   * database write. Production takes the real `syncRegistry`.
   */
  runSync?: typeof syncRegistry
}

export type MaybeSyncRegistryResult =
  | {
      ran: false
      reason: 'in_flight_here' | 'recently_completed' | 'peer_in_progress'
    }
  | { ran: true; result: SyncRegistryResult }

/**
 * Process-local single-flight. Set synchronously on entry — before the first
 * `await` — so two overlapping calls in one process (the ~60s post-startup kick
 * landing on top of the first interval tick) cannot both pass the gate. The
 * run-row check below is the *cross-process* guard; this closes the far more
 * common same-process double-fire.
 */
let inFlight = false

export const maybeSyncRegistry = async (
  prisma: PrismaClient,
  options: MaybeSyncRegistryOptions = {},
): Promise<MaybeSyncRegistryResult> => {
  if (inFlight) return { ran: false, reason: 'in_flight_here' }
  inFlight = true
  try {
    const now = options.now?.() ?? Date.now()
    const intervalMs = resolveIntervalMs(options.intervalMs)
    const staleMs = resolveStaleMs(options.staleMs)

    // The newest run overall — completed or still writing. `syncRegistry`
    // inserts its row at the very start of a walk, so a peer replica currently
    // walking the registry is visible here as a row with a null `completedAt`.
    const latest = await prisma.mcpRegistrySyncRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, completedAt: true },
    })

    if (latest) {
      if (latest.completedAt) {
        // A completed run inside the window: the store is fresh, do nothing.
        if (now - latest.completedAt.getTime() < intervalMs) {
          return { ran: false, reason: 'recently_completed' }
        }
      } else if (now - latest.startedAt.getTime() < staleMs) {
        // An in-progress row younger than the *liveness* window (not the 6h
        // re-sync interval) is another replica's walk currently in flight. Do
        // not start a second one. Once it passes `staleMs` with no completion
        // it is a zombie and this branch stops matching, so the sweep supersedes
        // it — otherwise a walk whose process died would wedge the store empty
        // until the full interval elapsed.
        //
        // RACE: two replicas can both read "nothing fresh" and both insert a
        // run row before either INSERT is visible to the other. This check
        // narrows that window to one sweep tick rather than eliminating it — a
        // rare double walk is wasteful, never corrupting, because `syncRegistry`
        // upserts on the stable `registryName`. A DB claim / advisory lock would
        // close it fully and is deliberately not worth the complexity here.
        return { ran: false, reason: 'peer_in_progress' }
      }
    }

    const runSync = options.runSync ?? syncRegistry
    // Bound the walk exactly as the CLI's full walk is bounded — the registry
    // client clamps to these — so a scheduled run cannot page the registry
    // unboundedly. Stated at the call site rather than left to the internal cap.
    const result = await runSync(prisma, {
      maxPages: REGISTRY_MAX_PAGES,
      maxRecords: REGISTRY_MAX_RECORDS,
      source: 'worker-scheduler',
    })
    return { ran: true, result }
  } finally {
    inFlight = false
  }
}
