import { captureSessionTabs, type CloudBrowserDeps } from '@nessie/browser-cloud'

import { acquireCdp, type SessionPoolDeps } from './session-pool.js'

/**
 * Write a session's tabs into its durable browser, from this worker's socket.
 *
 * Lives here rather than in the package because the socket does: the pool
 * either already holds the connection the run has been driving, or re-attaches
 * from the sealed capability — and a *second* automation connection beside a
 * live one can end the session, so the capture must ride the socket the pool
 * owns, never dial its own.
 *
 * Best effort, bounded, never throws: it runs beside the agent's next verb and
 * beside the release that stops the billing, and neither may wait on a
 * picture.
 */
export const captureTabsForSession = async (
  deps: CloudBrowserDeps,
  sessionId: string,
  options: { withScreenshots?: boolean } = {},
): Promise<boolean> => {
  const pool: SessionPoolDeps = { prisma: deps.prisma }
  try {
    const cdp = await acquireCdp(pool, sessionId)
    if (!cdp) return false
    return await captureSessionTabs(deps.prisma, {
      cdp,
      sessionId,
      withScreenshots: options.withScreenshots,
    })
  } catch {
    return false
  }
}

/**
 * Before a run's browsers are released, remember what they were on. The
 * terminal transition is the last moment the pages exist.
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
  for (const row of rows) {
    await captureTabsForSession(deps, row.id)
  }
}
