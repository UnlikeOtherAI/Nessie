import { connectCdp, type CdpClient } from '@nessie/browser-cloud'

import type { OriginGateState } from './origin-gate.js'

/**
 * Live CDP connections, keyed by our own session row id.
 *
 * A tool handler is built fresh for every call, so the connection cannot live
 * on the handler context; it lives here for the life of the worker process.
 * The database row stays the authority on whether a session exists — this is
 * only the socket attached to it.
 *
 * The connect URL is held here and nowhere else. It is a live-session bearer
 * capability, so it is deliberately never written to the database, a log, or
 * anything the model can read.
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
   * display text somebody typed at sign-in.
   */
  originGate: OriginGateState
}

const pool = new Map<string, PooledSession>()

/** Drop a session idle longer than this so a leaked socket cannot last. */
const IDLE_EVICTION_MS = 5 * 60 * 1000

const evictIdle = (now: number): void => {
  for (const [sessionId, entry] of pool) {
    if (now - entry.lastUsedAt <= IDLE_EVICTION_MS) continue
    pool.delete(sessionId)
    entry.cdp?.close()
  }
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
  evictIdle(Date.now())
  // Replacing an entry must not strand its socket.
  pool.get(sessionId)?.cdp?.close()
  pool.set(sessionId, {
    connectUrl,
    cdp: null,
    connecting: null,
    lastUsedAt: Date.now(),
    originGate,
  })
}

/** Null when this worker has no record of the session. */
export const originGateFor = (sessionId: string): OriginGateState | null =>
  pool.get(sessionId)?.originGate ?? null

/**
 * Returns null when this worker has no record of the session — a different
 * worker opened it, or this process restarted. The caller turns that into a
 * "reopen the browser" instruction rather than pretending to drive it.
 */
export const acquireCdp = async (sessionId: string): Promise<CdpClient | null> => {
  const now = Date.now()
  evictIdle(now)
  const entry = pool.get(sessionId)
  if (!entry) return null
  entry.lastUsedAt = now
  if (entry.cdp) return entry.cdp
  // Tool batches run concurrently, so two calls can reach this together. The
  // second awaits the first's socket instead of opening a rival one — a
  // second automation connection can itself end the session.
  if (entry.connecting) return entry.connecting

  entry.connecting = (async () => {
    const cdp = await connectCdp(entry.connectUrl)
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

export const releaseCdp = (sessionId: string): void => {
  const entry = pool.get(sessionId)
  if (!entry) return
  pool.delete(sessionId)
  entry.cdp?.close()
}

export const __testing = { pool, IDLE_EVICTION_MS }
