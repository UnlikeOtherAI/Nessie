import { Prisma, type PrismaClient } from '@prisma/client'
import { browserViewportOrDefault, type BrowserViewport } from '@nessie/schemas'

import { createBrowserbaseClient, type BrowserbaseClient } from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'
import { resolveConnectionForRun, type CloudBrowserDeps } from './session-lifecycle.js'

/**
 * An agent's own durable browser.
 *
 * The browser belongs to the agent — its machine — which is what makes
 * clashes structurally impossible: no two agents ever share browser state.
 * Shared team jars remain for unsigned public browsing. Personal sign-ins
 * belong in a private agent or Personal Assistant browser.
 */

/**
 * How long a hand-back stays a key.
 *
 * Long enough that a wake job queued behind an in-flight run still arrives to
 * a browser it may use, short enough that a job stuck in a backlog is not
 * still opening somebody's signed-in session an hour after they walked away.
 */
export const HANDBACK_GRACE_MS = 10 * 60 * 1000

export type AgentBrowserRow = {
  id: string
  connectionId: string
  browserbaseContextId: string
  /** The person whose state is in this jar, if it is not a team jar. */
  principalUserId: string | null
  loginCount: number
  /**
   * Set while a person's hand-back is still recent enough to act on. Null once
   * it has aged out, so a caller never has to know the rule.
   */
  handedBackByUserId: string | null
  /**
   * The window every session on this browser opens at. Resolved here rather
   * than carried as two nullable columns, because a browser nobody has sized
   * is not a browser with no size — it is one on the default, and a caller
   * handed `null` would have to invent that default itself.
   */
  viewport: BrowserViewport
}

/**
 * The two columns behind `AgentBrowserRow.viewport`, selected together
 * everywhere a row is read: the CHECK constraint keeps them both set or both
 * null, and reading one without the other cannot say which.
 */
const VIEWPORT_SELECT = { viewportWidth: true, viewportHeight: true } as const

const HANDBACK_SELECT = { handedBackAt: true, handedBackByUserId: true } as const

/** Null once the hand-back has aged out, so no caller has to know the rule. */
const handedBackByOf = (
  row: { handedBackAt: Date | null; handedBackByUserId: string | null },
  now: Date = new Date(),
): string | null =>
  row.handedBackByUserId !== null
    && row.handedBackAt !== null
    && now.getTime() - row.handedBackAt.getTime() <= HANDBACK_GRACE_MS
    ? row.handedBackByUserId
    : null

const viewportOf = (row: {
  viewportWidth: number | null
  viewportHeight: number | null
}): BrowserViewport =>
  browserViewportOrDefault({ width: row.viewportWidth, height: row.viewportHeight })

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
  // A browser that belongs to one person is treated exactly like a private
  // agent's, because that is what it is: the caller passes the principal as
  // the owner, and the personal-account preference below applies for the same
  // reason it does there — a company Browserbase administrator should not be
  // able to replay one person's own assistant.

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

export const loadClientForConnection = async (
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
/**
 * Whose cookie jar an agent's browser is.
 *
 * A system-managed agent — the Personal Assistant, every global agent — is one
 * row per organisation that each person meets through their own DM. Keyed by
 * agent alone, one browser served everybody: one person's Gmail sat inside
 * every colleague's assistant. So for those, the *principal* owns the jar.
 *
 * An ordinary team agent keeps one shared browser, which is what its sharing
 * banner promises and what people expect of a shared agent — bounded by its
 * own team, since it can only be bound to that team's channels
 * (`bindAgentToChannel`).
 *
 * Read from the database rather than taken from the caller: this is the line
 * between "my mailbox" and "the team's mailbox", and a caller that forgot to
 * pass a flag would silently put it back where it was.
 */
const principalForBrowser = async (
  prisma: Pick<PrismaClient, 'agent'>,
  input: {
    organizationId: string
    agentId: string
    agentVisibility: 'team' | 'private'
    agentOwnerUserId: string | null
    principalUserId: string | null
  },
): Promise<string | null> => {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: { systemManaged: true },
  })
  if (agent?.systemManaged) {
    if (input.principalUserId) return input.principalUserId
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'This assistant keeps a separate browser for each person, so it can only '
      + 'open one on behalf of somebody. An unattended run has no such person.',
    )
  }
  if (input.agentVisibility === 'private' && input.agentOwnerUserId) {
    return input.agentOwnerUserId
  }
  return null
}

const requirePersonalPrincipal = (principalUserId: string | null): string => {
  if (!principalUserId) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'This browser requires a person who can own its private context.',
    )
  }
  return principalUserId
}

export const ensureAgentBrowser = async (
  deps: CloudBrowserDeps,
  input: {
    organizationId: string
    agentId: string
    agentVisibility: 'team' | 'private'
    agentOwnerUserId: string | null
    /**
     * The requester for a system-managed agent's per-person jar. A private
     * ordinary agent instead resolves to `agentOwnerUserId`; a workspace agent
     * deliberately has no principal and uses its shared team jar.
     */
    principalUserId: string | null
  },
): Promise<AgentBrowserRow & { connection: { projectId: string | null; apiKeyRef: string } }> => {
  const principalUserId = await principalForBrowser(deps.prisma, input)
  const connection = await resolveDurableBrowserConnection(
    deps.prisma,
    principalUserId
      ? {
        ...input,
        agentVisibility: 'private',
        agentOwnerUserId: requirePersonalPrincipal(principalUserId),
      }
      : input,
  )

  const existing = await deps.prisma.agentBrowser.findFirst({
    where: {
      organizationId: input.organizationId,
      agentId: input.agentId,
      connectionId: connection.id,
      status: 'active',
      principalUserId,
    },
    select: {
      id: true,
      connectionId: true,
      browserbaseContextId: true,
      principalUserId: true,
      ...VIEWPORT_SELECT,
      ...HANDBACK_SELECT,
      _count: { select: { logins: true } },
    },
  })
  if (existing) {
    return {
      id: existing.id,
      connectionId: existing.connectionId,
      browserbaseContextId: existing.browserbaseContextId,
      principalUserId: existing.principalUserId,
      loginCount: existing._count.logins,
      handedBackByUserId: handedBackByOf(existing),
      viewport: viewportOf(existing),
      connection: { projectId: connection.projectId, apiKeyRef: connection.apiKeyRef },
    }
  }

  return deps.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{
      apiKeyRef: string
      id: string
      projectId: string | null
    }>>(Prisma.sql`SELECT id, project_id AS "projectId", api_key_ref AS "apiKeyRef"
      FROM cloud_browser_connections
      WHERE id = ${connection.id}::uuid
        AND organization_id = ${input.organizationId}::uuid
        AND status = 'active'
      FOR UPDATE`)
    const activeConnection = locked[0]
    if (!activeConnection) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
        'This Browserbase connection was disconnected. Reconnect it before creating a saved browser.',
      )
    }
    const winner = await tx.agentBrowser.findFirst({
      where: {
        organizationId: input.organizationId,
        agentId: input.agentId,
        connectionId: activeConnection.id,
        status: 'active',
        principalUserId,
      },
      select: {
        id: true,
        connectionId: true,
        browserbaseContextId: true,
        principalUserId: true,
        ...VIEWPORT_SELECT,
        ...HANDBACK_SELECT,
        _count: { select: { logins: true } },
      },
    })
    if (winner) {
      return {
        id: winner.id,
        connectionId: winner.connectionId,
        browserbaseContextId: winner.browserbaseContextId,
        principalUserId: winner.principalUserId,
        loginCount: winner._count.logins,
        handedBackByUserId: handedBackByOf(winner),
        viewport: viewportOf(winner),
        connection: { projectId: activeConnection.projectId, apiKeyRef: activeConnection.apiKeyRef },
      }
    }
    const client = await loadClientForConnection(deps, activeConnection)
    const context = await client.createContext()
    try {
      const created = await tx.agentBrowser.create({
        data: {
          organizationId: input.organizationId,
          agentId: input.agentId,
          connectionId: activeConnection.id,
          browserbaseContextId: context.id,
          principalUserId,
        },
        select: {
          id: true,
          connectionId: true,
          browserbaseContextId: true,
          principalUserId: true,
          ...VIEWPORT_SELECT,
          ...HANDBACK_SELECT,
        },
      })
      return {
        id: created.id,
        connectionId: created.connectionId,
        browserbaseContextId: created.browserbaseContextId,
        principalUserId: created.principalUserId,
        loginCount: 0,
        handedBackByUserId: handedBackByOf(created),
        viewport: viewportOf(created),
        connection: { projectId: activeConnection.projectId, apiKeyRef: activeConnection.apiKeyRef },
      }
    } catch (error) {
      await client.deleteContext(context.id).catch((cause: unknown) => {
        console.warn(
          '[browser-cloud] orphaned Browserbase context — delete it from the '
          + `Browserbase dashboard: ${context.id}`,
          cause,
        )
      })
      throw error
    }
  })
}

export { reconcileTombstonedAgentBrowsers, resetAgentBrowser } from './agent-browser-retirement.js'

export { resolveConnectionForRun, isCloudBrowserError }
