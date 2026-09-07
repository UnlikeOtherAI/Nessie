import { Prisma } from '@prisma/client'

import { captureTabsAtConnectUrl } from './agent-browser-tabs.js'
import { loadSessionCapability } from './session-capability.js'
import {
  BLOCKING_SESSION_STATUSES,
  loadClient,
  type CloudBrowserDeps,
} from './session-foundation.js'

/**
 * Stop one session, locally and remotely.
 *
 * The local claim comes first (`live → releasing`) so two releasers cannot
 * both call Browserbase, and the row only reaches `released` once the remote
 * stop returned. A remote failure leaves `unknown` rather than `released`,
 * because a row that says released while a browser is still billing is the
 * one lie this table must not tell.
 */
export const releaseCloudBrowserSession = async (
  deps: CloudBrowserDeps,
  input: { sessionId: string; releasedBy: string; skipCapture?: boolean },
): Promise<boolean> => {
  // A resumed session's last state is written on the way out: a run's session
  // was captured by its worker, but nothing drives a resumed one, and this is
  // its last moment with pages. The capability is read *before* the claim
  // below clears it, and used *after* — so the claim, which is what stops a
  // second releaser calling Browserbase, is never held up by a picture.
  let lastLook: string | null = null
  if (!input.skipCapture && deps.encryptionSecret) {
    const resumed = await deps.prisma.cloudBrowserSession.count({
      where: { id: input.sessionId, runId: null, status: 'active', agentBrowserId: { not: null } },
    })
    if (resumed === 1) {
      const capability = await loadSessionCapability(deps.prisma, {
        sessionId: input.sessionId,
        encryptionSecret: deps.encryptionSecret,
      })
      lastLook = capability?.connectUrl ?? null
    }
  }
  // `releasing` is deliberately NOT claimable: three writers can race here
  // (the tool, the terminal transition, the reaper) and including it let two
  // of them both call Browserbase, with the loser's failure path then
  // overwriting the winner's `released` row.
  const claimed = await deps.prisma.cloudBrowserSession.updateMany({
    where: { id: input.sessionId, status: { in: ['allocating', 'active', 'unknown'] } },
    // The capability dies with the claim, not with the remote stop: from here
    // the session is not drivable by anyone, and a sealed connect URL sitting
    // in a released row is a bearer token with no session to bound it.
    data: { status: 'releasing', connectCapabilityCiphertext: null, originGate: Prisma.DbNull },
  })
  if (claimed.count !== 1) return false

  // Bounded (`CAPTURE_TIMEOUT_MS`) and never throws: the remote stop below
  // runs whatever happens here.
  if (lastLook) {
    await captureTabsAtConnectUrl(deps.prisma, {
      sessionId: input.sessionId,
      connectUrl: lastLook,
      connect: deps.connect,
    })
  }

  const row = await deps.prisma.cloudBrowserSession.findUnique({
    where: { id: input.sessionId },
    select: {
      browserbaseSessionId: true,
      connection: { select: { id: true, projectId: true, apiKeyRef: true, scope: true } },
    },
  })

  if (!row?.browserbaseSessionId) {
    // Nothing was ever created remotely (or the create never returned an id):
    // the reconciler owns that case, not this path.
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: input.sessionId },
      data: { status: 'released', endedAt: new Date(), releasedBy: input.releasedBy },
    })
    return true
  }

  try {
    const client = await loadClient(deps, {
      id: row.connection.id,
      scope: row.connection.scope,
      projectId: row.connection.projectId,
      apiKeyRef: row.connection.apiKeyRef,
    })
    await client.endSession(row.browserbaseSessionId)
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: input.sessionId },
      data: { status: 'released', endedAt: new Date(), releasedBy: input.releasedBy },
    })
    return true
  } catch (error) {
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: input.sessionId },
      data: {
        status: 'unknown',
        endedAt: new Date(),
        releasedBy: input.releasedBy,
        lastError: (error as Error).message.slice(0, 500),
      },
    })
    return false
  }
}

/**
 * Release whatever a run still holds. Fused to the run's terminal transition
 * so completion, failure, budget stop and cancellation all free the browser
 * without anyone remembering to.
 */
export const releaseSessionsForRun = async (
  deps: CloudBrowserDeps,
  input: { runId: string; releasedBy: string },
): Promise<number> => {
  // A terminal run revokes personal consent before any provider call. A
  // remote timeout can leave the session `unknown`, never the grant usable.
  await deps.prisma.browserPersonalAccessGrant.updateMany({
    where: { runId: input.runId, status: { in: ['pending', 'active'] } },
    data: { revokedAt: new Date(), status: 'revoked' },
  })
  const rows = await deps.prisma.cloudBrowserSession.findMany({
    where: { runId: input.runId, status: { in: [...BLOCKING_SESSION_STATUSES] } },
    select: { id: true },
  })
  let released = 0
  for (const row of rows) {
    if (await releaseCloudBrowserSession(deps, {
      sessionId: row.id,
      releasedBy: input.releasedBy,
    })) {
      released += 1
    }
  }
  return released
}

/**
 * Stop sessions whose run crashed before any terminal transition, or that
 * outlived their TTL. Reaping means calling Browserbase — a row flipped
 * locally while the remote browser keeps billing is exactly the leak this
 * exists to prevent.
 */
export const reapExpiredCloudBrowserSessions = async (
  deps: CloudBrowserDeps,
  options: { limit?: number } = {},
): Promise<number> => {
  const now = deps.now?.() ?? new Date()
  // A waiting card has no CloudBrowserSession yet, so the session reaper is
  // also its expiry authority. This closes the local grant before any remote
  // stop attempt and prevents a later card press from reviving it.
  await deps.prisma.browserPersonalAccessGrant.updateMany({
    where: { expiresAt: { lte: now }, status: { in: ['pending', 'active'] } },
    data: { revokedAt: now, status: 'expired' },
  })
  const rows = await deps.prisma.cloudBrowserSession.findMany({
    where: {
      // `unknown` is included on purpose: it is the state a failed remote stop
      // leaves behind, and it is exactly the row most likely to still be
      // costing money.
      status: { in: [...BLOCKING_SESSION_STATUSES] },
      expiresAt: { lte: now },
    },
    select: { id: true },
    take: options.limit ?? 20,
    orderBy: { expiresAt: 'asc' },
  })
  let reaped = 0
  for (const row of rows) {
    await deps.prisma.browserPersonalAccessGrant.updateMany({
      where: { sessionId: row.id, status: 'active' },
      data: { revokedAt: now, status: 'expired' },
    })
    if (await releaseCloudBrowserSession(deps, {
      sessionId: row.id,
      releasedBy: 'reaper',
    })) {
      reaped += 1
    }
  }
  return reaped
}
