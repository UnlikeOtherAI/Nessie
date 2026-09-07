import type { PrismaClient } from '@prisma/client'

import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'
import { loadClientForConnection } from './agent-browser.js'
import { BLOCKING_SESSION_STATUSES, type CloudBrowserDeps } from './session-foundation.js'

/**
 * Sign the agent out of everything: tombstone the row so no run can reach the
 * context again, then let the reconciler delete it remotely.
 *
 * Two honest limits the copy must state. Deleting a context does not revoke
 * the *service's* own server-side session — fully signing out means the
 * service's security page too. And it is all-or-nothing: per-service cookie
 * deletion is phase-3 polish, so this clears every signer's login at once.
 */
export const resetAgentBrowser = async (
  prisma: PrismaClient,
  input: { organizationId: string; agentBrowserId: string },
): Promise<{ tombstoned: boolean }> => {
  return prisma.$transaction(async (tx) => {
    // Read only enough to find the parent before taking locks. Every mutation
    // then takes parent → browser: disconnect/rekey hold the parent while they
    // decide whether a retiring context can still be cleaned up.
    const candidate = await tx.agentBrowser.findFirst({
      where: { id: input.agentBrowserId, organizationId: input.organizationId },
      select: { connectionId: true },
    })
    if (!candidate) return { tombstoned: false }
    const connections = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM cloud_browser_connections
      WHERE id = ${candidate.connectionId}::uuid
        AND organization_id = ${input.organizationId}::uuid
        AND status = 'active'
      FOR UPDATE
    `
    if (!connections[0]) return { tombstoned: false }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM agent_browsers
      WHERE id = ${input.agentBrowserId}::uuid
        AND organization_id = ${input.organizationId}::uuid
        AND connection_id = ${candidate.connectionId}::uuid
        AND status = 'active'
      FOR UPDATE
    `
    if (!rows[0]) return { tombstoned: false }
    const live = await tx.cloudBrowserSession.count({
      where: {
        agentBrowserId: input.agentBrowserId,
        status: { in: [...BLOCKING_SESSION_STATUSES] },
      },
    })
    if (live > 0) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.CAPACITY,
        'This browser is open right now. Close it first, then reset it.',
      )
    }
    await tx.agentBrowser.update({
      where: { id: input.agentBrowserId },
      data: { status: 'tombstoned', tombstonedAt: new Date() },
    })
    // The logins go with the browser: they describe state that no longer
    // exists, and leaving them would misreport who the agent is signed in as.
    await tx.agentBrowserLogin.deleteMany({ where: { agentBrowserId: input.agentBrowserId } })
    return { tombstoned: true }
  })
}

/**
 * How long a row claimed into `deleting` is trusted to belong to a live
 * delete before another tick may take it over.
 *
 * `deleting` is a claim, and every claim taken before a side effect needs a
 * horizon or it is a permanent drop (docs/standards/horizontal-scaling/overview.md §3):
 * a process killed between the claim and the provider's answer used to leave
 * the row in `deleting` forever, and the sweep only selected `tombstoned` — so
 * a Browserbase context holding somebody's encrypted login state leaked with
 * no reaper and no alert.
 *
 * Ten minutes, matching `STRANDED_RUN_MS` in the automatic-membership sweep.
 * The reaper ticks every 30 s and the claimed work is *one* HTTP call to
 * Browserbase, so ten minutes is roughly twenty times any plausible delete —
 * a live one is never stolen — while a killed process's row is picked up on
 * the next tick past the horizon rather than never.
 */
const DELETING_CLAIM_HORIZON_MS = 10 * 60 * 1000

/**
 * Delete the Browserbase contexts behind tombstoned rows.
 *
 * The row is only removed once the provider confirms — a local delete while
 * the context still exists would orphan encrypted login state in somebody's
 * Browserbase account with nothing pointing at it.
 */
export const reconcileTombstonedAgentBrowsers = async (
  deps: CloudBrowserDeps,
  options: { limit?: number } = {},
): Promise<number> => {
  // A row is this sweep's to take if it is tombstoned, or if it is a
  // `deleting` claim old enough to be a corpse. `updatedAt` is the claim's
  // age: Prisma stamps it on the claiming `UPDATE`, so it moves forward each
  // time a reconciler takes the row over and cannot drift backwards.
  const claimable = [
    { status: 'tombstoned' as const },
    {
      status: 'deleting' as const,
      updatedAt: { lt: new Date(Date.now() - DELETING_CLAIM_HORIZON_MS) },
    },
  ]
  const rows = await deps.prisma.agentBrowser.findMany({
    where: { OR: claimable },
    select: {
      id: true,
      browserbaseContextId: true,
      connection: { select: { projectId: true, apiKeyRef: true } },
    },
    take: options.limit ?? 20,
    orderBy: { tombstonedAt: 'asc' },
  })
  let deleted = 0
  for (const row of rows) {
    // Last line of defence for the reset/open race: never delete a context a
    // live session is still attached to, however it got there.
    const live = await deps.prisma.cloudBrowserSession.count({
      where: {
        agentBrowserId: row.id,
        status: { in: [...BLOCKING_SESSION_STATUSES] },
      },
    })
    if (live > 0) continue

    // Claim the row before touching the provider (horizontal-scaling audit
    // 5.10). The `findMany` above is a snapshot every replica reads alike, so
    // read-then-delete had N reconcilers calling Browserbase for the same
    // context: one won, and each loser's "no such context" was written to
    // `lastError` as though the row were broken. A conditional
    // `tombstoned → deleting` is the right primitive rather than a lock —
    // there is no indivisible walk here, just one row and one provider call,
    // and the status is also what keeps the *next* tick from picking the row
    // up while this delete is still in flight. The same statement is the
    // takeover of a stranded claim: re-stamping `deleting` on a row past
    // `DELETING_CLAIM_HORIZON_MS` moves `updatedAt`, so exactly one of the
    // replicas that saw the corpse gets it and the rest lose the same way
    // they lose a fresh tombstone.
    const claimed = await deps.prisma.agentBrowser.updateMany({
      where: { id: row.id, OR: claimable },
      data: { status: 'deleting' },
    })
    if (claimed.count !== 1) continue

    try {
      const client = await loadClientForConnection(deps, row.connection)
      await client.deleteContext(row.browserbaseContextId)
      await deps.prisma.agentBrowser.delete({ where: { id: row.id } })
      deleted += 1
    } catch (error) {
      // Hand the row back, or a provider blip strands the context in
      // `deleting` where no sweep will ever look at it again.
      await deps.prisma.agentBrowser.updateMany({
        where: { id: row.id, status: 'deleting' },
        data: { lastError: (error as Error).message.slice(0, 500), status: 'tombstoned' },
      }).catch(() => undefined)
    }
  }
  return deleted
}
