import type { PrismaClient } from '@prisma/client'
import {
  connectCdp,
  loadSessionCapability,
  persistOriginGate,
  type CdpClient,
} from '@nessie/browser-cloud'
import { loadConfig } from '@nessie/config'

import {
  deserialiseOriginGate,
  serialiseOriginGate,
  type OriginGateState,
} from './origin-gate.js'

/**
 * Live CDP connections, keyed by our own session row id.
 *
 * **A socket cache, not an authority.** The authority is
 * `cloud_browser_sessions`: it holds the session's status, the sealed connect
 * URL and the origin gate, and every lookup here is read-through — a miss
 * loads the row, unseals the capability and reconnects, so a run re-claimed by
 * a second worker after an approval drives the same browser instead of
 * dead-ending on `SESSION_ALREADY_OPEN` while the session bills to its TTL
 * (audit 8.1, docs/standards/horizontal-scaling.md § 1).
 *
 * What stays per process is exactly the thing whose lifetime *is* this
 * process: an open WebSocket. Losing it costs one reconnect, never a decision.
 */

type PooledSession = {
  connectUrl: string
  cdp: CdpClient | null
  /** In-flight connect, so concurrent tool calls share one socket. */
  connecting: Promise<CdpClient> | null
  lastUsedAt: number
  /**
   * Which origins this browser holds cookies for, and whether it has actually
   * been to one. Read once at open from the browser itself, because the
   * cross-origin write gate must key on a mechanical fact rather than on the
   * display text somebody typed at sign-in. Mirrored to the row on change, so
   * the next worker gates on the same facts.
   */
  originGate: OriginGateState
  /** The gate as last written, so an unchanged gate costs no UPDATE. */
  persistedGate: string
}

const pool = new Map<string, PooledSession>()

/** Drop a session idle longer than this so a leaked socket cannot last. */
const IDLE_EVICTION_MS = 5 * 60 * 1000

/**
 * What the pool needs to reach the authority. `connect` is a test seam — the
 * same shape `CloudBrowserDeps.clientFactory` is — so the re-attach path can
 * be proven without a browser.
 */
export type SessionPoolDeps = {
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>
  connect?: (connectUrl: string) => Promise<CdpClient>
}

/**
 * The deployment secret the connect capability is sealed with. Exported
 * because `browser_open` has to hand the same secret to
 * `openCloudBrowserSession`, and one reader keeps the two ends in step.
 */
export const capabilitySealSecret = (): string => loadConfig().auth.secret ?? ''

const evictIdle = (now: number): void => {
  for (const [sessionId, entry] of pool) {
    if (now - entry.lastUsedAt <= IDLE_EVICTION_MS) continue
    pool.delete(sessionId)
    entry.cdp?.close()
  }
}

const cache = (
  sessionId: string,
  connectUrl: string,
  originGate: OriginGateState,
): PooledSession => {
  evictIdle(Date.now())
  // Replacing an entry must not strand its socket.
  pool.get(sessionId)?.cdp?.close()
  const entry: PooledSession = {
    connectUrl,
    cdp: null,
    connecting: null,
    lastUsedAt: Date.now(),
    originGate,
    persistedGate: JSON.stringify(serialiseOriginGate(originGate)),
  }
  pool.set(sessionId, entry)
  return entry
}

export const registerSession = (
  sessionId: string,
  connectUrl: string,
  originGate: OriginGateState = {
    authenticatedOrigins: new Set(),
    currentUrl: null,
    touchedAuthenticated: false,
  },
): void => {
  cache(sessionId, connectUrl, originGate)
}

/**
 * The pooled entry for a session, loading it from the row on a miss. Null when
 * the session is not drivable from anywhere — released, expired, or with no
 * capability stored.
 */
const entryFor = async (
  deps: SessionPoolDeps,
  sessionId: string,
): Promise<PooledSession | null> => {
  const now = Date.now()
  evictIdle(now)
  const pooled = pool.get(sessionId)
  if (pooled) {
    pooled.lastUsedAt = now
    return pooled
  }
  const capability = await loadSessionCapability(deps.prisma, {
    sessionId,
    encryptionSecret: capabilitySealSecret(),
  })
  if (!capability) return null
  return cache(sessionId, capability.connectUrl, deserialiseOriginGate(capability.originGate))
}

/**
 * The gate this session is under, or null when none is persisted.
 *
 * Null is not "no restrictions": it means the gate cannot be read at all, and
 * the caller escalates rather than waving a write through — the pool used to
 * return null on a miss and `act-approval-gate` read that as "nothing to gate".
 */
export const originGateFor = async (
  deps: SessionPoolDeps,
  sessionId: string,
): Promise<OriginGateState | null> => (await entryFor(deps, sessionId))?.originGate ?? null

/**
 * Mirror an in-process gate change to the row, so the next worker to claim
 * this run gates on what this one learned. Skipped when nothing changed.
 */
export const saveOriginGate = async (
  deps: SessionPoolDeps,
  sessionId: string,
  gate: OriginGateState,
): Promise<void> => {
  const serialised = serialiseOriginGate(gate)
  const encoded = JSON.stringify(serialised)
  const entry = pool.get(sessionId)
  if (entry?.persistedGate === encoded) return
  await persistOriginGate(deps.prisma, { sessionId, originGate: serialised })
  if (entry) entry.persistedGate = encoded
}

/**
 * Returns null when the session is not drivable at all — released, expired, or
 * never reached `active`. A worker that simply did not open it re-attaches
 * from the row instead, which is what lets a suspended run resume anywhere.
 */
export const acquireCdp = async (
  deps: SessionPoolDeps,
  sessionId: string,
): Promise<CdpClient | null> => {
  const entry = await entryFor(deps, sessionId)
  if (!entry) return null
  if (entry.cdp) return entry.cdp
  // Tool batches run concurrently, so two calls can reach this together. The
  // second awaits the first's socket instead of opening a rival one — a
  // second automation connection can itself end the session.
  if (entry.connecting) return entry.connecting

  const dial = deps.connect ?? connectCdp
  entry.connecting = (async () => {
    const cdp = await dial(entry.connectUrl)
    await cdp.attachToPage()
    // A socket that dies on its own must not be handed to the next call.
    void cdp.closed.then(() => {
      const current = pool.get(sessionId)
      if (current?.cdp === cdp) current.cdp = null
    })
    entry.cdp = cdp
    return cdp
  })()
  try {
    return await entry.connecting
  } finally {
    entry.connecting = null
  }
}

/** Drop this worker's socket. The row, and any other worker, are untouched. */
export const releaseCdp = (sessionId: string): void => {
  const entry = pool.get(sessionId)
  if (!entry) return
  pool.delete(sessionId)
  entry.cdp?.close()
}

export const __testing = { pool, IDLE_EVICTION_MS }
