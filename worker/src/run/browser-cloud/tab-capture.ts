import { CAPTURE_TIMEOUT_MS, captureSessionTabs, type CloudBrowserDeps } from '@nessie/browser-cloud'

import { acquireCdp, type SessionPoolDeps } from './session-pool.js'

/**
 * Capture a session's tabs over the socket the pool owns — the one the run
 * has been driving, or a re-attach from the sealed capability. Never a dial of
 * its own: `session-pool.ts` says why a second connection beside a live one
 * is not an option. Bounded and never throws.
 */
export const captureTabsOverPoolSocket = async (
  deps: CloudBrowserDeps,
  sessionId: string,
): Promise<boolean> => {
  const pool: SessionPoolDeps = { prisma: deps.prisma }
  try {
    const cdp = await acquireCdp(pool, sessionId)
    if (!cdp) return false
    return await captureSessionTabs(deps.prisma, { cdp, sessionId })
  } catch {
    return false
  }
}

/**
 * One capture in flight per session, and at most one queued behind it.
 *
 * A verb must not wait for pictures — that was up to ten seconds added to
 * every `browser_act` — but nor may two captures run at once against one
 * socket, attaching and detaching under the verb that follows. So a verb
 * *schedules* a capture and moves on; a second request while one is running
 * marks it to run again, which folds any number of quick verbs into one more
 * pass that sees the latest pages. Close and release `await` the tail.
 */
const inFlight = new Map<string, { run: Promise<void>; again: boolean }>()

export const scheduleTabCapture = (deps: CloudBrowserDeps, sessionId: string): void => {
  const current = inFlight.get(sessionId)
  if (current) {
    current.again = true
    return
  }
  const entry = { again: false, run: Promise.resolve() }
  entry.run = (async () => {
    do {
      entry.again = false
      await captureTabsOverPoolSocket(deps, sessionId)
    } while (entry.again)
    inFlight.delete(sessionId)
  })()
  inFlight.set(sessionId, entry)
}

/** Wait for whatever capture is running for this session, then take one more. */
export const captureTabsNow = async (deps: CloudBrowserDeps, sessionId: string): Promise<boolean> => {
  await inFlight.get(sessionId)?.run
  return captureTabsOverPoolSocket(deps, sessionId)
}

/**
 * Before a run's browsers are released, remember what they were on. The
 * terminal transition is the last moment the pages exist — and the release
 * it precedes is what stops the billing, so every session is captured at
 * once under one bound rather than one after another.
 */
export const captureTabsForRun = async (
  deps: CloudBrowserDeps,
  runId: string,
): Promise<void> => {
  const rows = await deps.prisma.cloudBrowserSession.findMany({
    where: {
      runId,
      status: { in: ['allocating', 'active'] },
      agentBrowserId: { not: null },
    },
    select: { id: true },
  })
  if (rows.length === 0) return
  await Promise.race([
    Promise.allSettled(rows.map((row) => captureTabsNow(deps, row.id))),
    new Promise<void>((resolve) => { setTimeout(resolve, CAPTURE_TIMEOUT_MS).unref?.() }),
  ])
}
