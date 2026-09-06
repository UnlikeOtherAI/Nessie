import { Prisma, type PrismaClient } from '@prisma/client'

import { createBrowserbaseClient, type BrowserbaseClient } from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'
import { resolveConnectionForRun, type CloudBrowserDeps } from './session-lifecycle.js'

/**
 * An agent's own durable browser.
 *
 * The browser belongs to the agent — its machine — which is what makes
 * clashes structurally impossible: no two agents ever share browser state.
 * What a person signs into it is shared with everyone who can reach that
 * agent, which the viewer says out loud before the first keystroke and the
 * disclosure basis enforces afterwards.
 */

export type AgentBrowserRow = {
  id: string
  connectionId: string
  browserbaseContextId: string
  loginCount: number
}

/**
 * Which connection may hold an agent's durable browser.
 *
 * A team agent's browser lives on the organisation connection only: on
 * somebody's personal account its state would be reachable through runs that
 * account's owner never requested, and their Browserbase dashboard would hold
 * a colleague's browsing. A private agent — owner-only home DM, owner-only
 * runs by construction — may use its owner's personal connection, which is
 * exactly the free-tier on-ramp.
 */
export const resolveDurableBrowserConnection = async (
  prisma: Pick<PrismaClient, 'cloudBrowserConnection'>,
  input: {
    organizationId: string
    agentVisibility: 'team' | 'private'
    agentOwnerUserId: string | null
  },
): Promise<{ id: string; scope: 'organization' | 'team' | 'user'; projectId: string | null; apiKeyRef: string }> => {
  const rows = await prisma.cloudBrowserConnection.findMany({
    where: { organizationId: input.organizationId, status: 'active' },
    select: { id: true, scope: true, projectId: true, apiKeyRef: true, userId: true },
  })
  const organization = rows.find((row) => row.scope === 'organization')

  if (input.agentVisibility === 'private' && input.agentOwnerUserId) {
    // Preferred over the organisation account even when one exists: a private
    // agent's browsing would otherwise be replayable by the company's
    // Browserbase administrator, which is not the privacy the label implies.
    const personal = rows.find(
      (row) => row.scope === 'user' && row.userId === input.agentOwnerUserId,
    )
    if (personal) return personal
  }

  if (!organization) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      input.agentVisibility === 'private'
        ? 'No Browserbase account is connected. Connect your own in settings, or ask an owner to connect the company account.'
        : 'This agent needs the company Browserbase account, which is not connected. A personal account cannot hold a shared agent’s browser.',
    )
  }
  return organization
}

const loadClientForConnection = async (
  deps: CloudBrowserDeps,
  connection: { projectId: string | null; apiKeyRef: string },
): Promise<BrowserbaseClient> => {
  const apiKey = await deps.resolveSecret(connection.apiKeyRef)
  if (!apiKey) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED,
      'The stored Browserbase key could not be read. Reconnect the account.',
    )
  }
  const credentials = { apiKey, projectId: connection.projectId }
  return deps.clientFactory ? deps.clientFactory(credentials) : createBrowserbaseClient(credentials)
}

/**
 * Find or create the agent's browser.
 *
 * The remote context is created *before* the row, because a row pointing at a
 * context that was never created is a browser that can never open, while the
 * reverse is recoverable. If two runs race, the partial unique index picks one
 * winner and the loser's freshly created context is deleted immediately.
 *
 * If that delete fails, the context is genuinely orphaned: nothing points at
 * it, so no sweep can find it, and it holds login-capable state in somebody's
 * Browserbase account. That is logged loudly rather than swallowed — the
 * account holder can delete it from their dashboard — and it is the reason
 * the delete is attempted inline rather than deferred.
 */
export const ensureAgentBrowser = async (
  deps: CloudBrowserDeps,
  input: {
    organizationId: string
    agentId: string
    agentVisibility: 'team' | 'private'
    agentOwnerUserId: string | null
  },
): Promise<AgentBrowserRow & { connection: { projectId: string | null; apiKeyRef: string } }> => {
  const connection = await resolveDurableBrowserConnection(deps.prisma, input)

  const existing = await deps.prisma.agentBrowser.findFirst({
    where: {
      organizationId: input.organizationId,
      agentId: input.agentId,
      connectionId: connection.id,
      status: 'active',
    },
    select: {
      id: true,
      connectionId: true,
      browserbaseContextId: true,
      _count: { select: { logins: true } },
    },
  })
  if (existing) {
    return {
      id: existing.id,
      connectionId: existing.connectionId,
      browserbaseContextId: existing.browserbaseContextId,
      loginCount: existing._count.logins,
      connection: { projectId: connection.projectId, apiKeyRef: connection.apiKeyRef },
    }
  }

  const client = await loadClientForConnection(deps, connection)
  const context = await client.createContext()

  try {
    const created = await deps.prisma.agentBrowser.create({
      data: {
        organizationId: input.organizationId,
        agentId: input.agentId,
        connectionId: connection.id,
        browserbaseContextId: context.id,
      },
      select: { id: true, connectionId: true, browserbaseContextId: true },
    })
    return {
      ...created,
      loginCount: 0,
      connection: { projectId: connection.projectId, apiKeyRef: connection.apiKeyRef },
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Another run won the race. Release the context we just made rather
      // than leaving it for the reconciler, and use theirs.
      await client.deleteContext(context.id).catch((cause: unknown) => {
        console.warn(
          '[browser-cloud] orphaned Browserbase context (race loser) — delete it '
          + `from the Browserbase dashboard: ${context.id}`,
          cause,
        )
      })
      const winner = await deps.prisma.agentBrowser.findFirstOrThrow({
        where: {
          organizationId: input.organizationId,
          agentId: input.agentId,
          connectionId: connection.id,
          status: 'active',
        },
        select: {
          id: true,
          connectionId: true,
          browserbaseContextId: true,
          _count: { select: { logins: true } },
        },
      })
      return {
        id: winner.id,
        connectionId: winner.connectionId,
        browserbaseContextId: winner.browserbaseContextId,
        loginCount: winner._count.logins,
        connection: { projectId: connection.projectId, apiKeyRef: connection.apiKeyRef },
      }
    }
    await client.deleteContext(context.id).catch((cause: unknown) => {
      console.warn(
        '[browser-cloud] orphaned Browserbase context — delete it from the '
        + `Browserbase dashboard: ${context.id}`,
        cause,
      )
    })
    throw error
  }
}

/**
 * Record that a person signed this browser into a service.
 *
 * Audit and revocation only — whether a *session* counts as authenticated is
 * a monotone fact on the session row, because somebody can also sign in
 * during an ad-hoc control claim that writes no login row at all.
 */
export const recordAgentBrowserLogin = async (
  prisma: Pick<PrismaClient, 'agentBrowserLogin'>,
  input: {
    organizationId: string
    agentBrowserId: string
    userId: string
    serviceHint: string
  },
): Promise<void> => {
  await prisma.agentBrowserLogin.create({
    data: {
      organizationId: input.organizationId,
      agentBrowserId: input.agentBrowserId,
      userId: input.userId,
      serviceHint: input.serviceHint.slice(0, 200),
    },
  })
}

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
  const live = await prisma.cloudBrowserSession.count({
    where: {
      agentBrowserId: input.agentBrowserId,
      status: { in: ['allocating', 'active', 'releasing'] },
    },
  })
  if (live > 0) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.CAPACITY,
      'This browser is open right now. Close it first, then reset it.',
    )
  }
  const updated = await prisma.agentBrowser.updateMany({
    where: {
      id: input.agentBrowserId,
      organizationId: input.organizationId,
      status: 'active',
    },
    data: { status: 'tombstoned', tombstonedAt: new Date() },
  })
  if (updated.count === 1) {
    // The logins go with the browser: they describe state that no longer
    // exists, and leaving them would misreport who the agent is signed in as.
    await prisma.agentBrowserLogin.deleteMany({
      where: { agentBrowserId: input.agentBrowserId },
    })
  }
  return { tombstoned: updated.count === 1 }
}

/**
 * How long a row claimed into `deleting` is trusted to belong to a live
 * delete before another tick may take it over.
 *
 * `deleting` is a claim, and every claim taken before a side effect needs a
 * horizon or it is a permanent drop (docs/standards/horizontal-scaling.md §3):
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
        status: { in: ['allocating', 'active', 'releasing'] },
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

/**
 * Facts about an agent's browser for the structural prompt block, so the
 * model knows whether it has one and what it is signed into without being
 * told by message content.
 */
export const describeAgentBrowser = async (
  prisma: Pick<PrismaClient, 'agentBrowser' | 'cloudBrowserSession'>,
  input: { organizationId: string; agentId: string },
): Promise<{ exists: boolean; services: string[]; inUse: boolean } | null> => {
  const browser = await prisma.agentBrowser.findFirst({
    where: { organizationId: input.organizationId, agentId: input.agentId, status: 'active' },
    select: { id: true, logins: { select: { serviceHint: true }, take: 20 } },
  })
  if (!browser) return { exists: false, services: [], inUse: false }
  const live = await prisma.cloudBrowserSession.count({
    where: {
      agentBrowserId: browser.id,
      status: { in: ['allocating', 'active', 'releasing'] },
    },
  })
  return {
    exists: true,
    services: [...new Set(browser.logins.map((row) => row.serviceHint))],
    inUse: live > 0,
  }
}

/**
 * Who may see what a durable browser shows — its live view, and now the
 * pictures it left behind — and who may pick it up.
 *
 * A browser nobody has signed in is what the agent could see anyway, so its
 * audience is whoever can reach the conversation. Once a person has signed it
 * in, what it shows is *their* material: the audience narrows to the people
 * with a login row on it, plus whoever asked for the session in front of you,
 * who is looking at their own request. One rule, used by every reader — the
 * session detail, the session list, the stored tabs, and the resume — because
 * the first version of this feature had three, and the idle face showed a
 * colleague the inbox the live face hid from them.
 */
export const viewerMaySeeAgentBrowser = async (
  prisma: Pick<PrismaClient, 'agentBrowserLogin'>,
  input: { agentBrowserId: string; viewerId: string; requestedByUserId?: string | null },
): Promise<boolean> => {
  if (input.requestedByUserId === input.viewerId) return true
  const logins = await prisma.agentBrowserLogin.findMany({
    where: { agentBrowserId: input.agentBrowserId },
    select: { userId: true },
  })
  if (logins.length === 0) return true
  return logins.some((row) => row.userId === input.viewerId)
}

export { resolveConnectionForRun, isCloudBrowserError }
