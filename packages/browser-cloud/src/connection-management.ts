import { Prisma, type PrismaClient } from '@prisma/client'

import { createBrowserbaseClient, type BrowserbaseClient } from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'
import { BLOCKING_SESSION_STATUSES } from './session-lifecycle.js'

/**
 * Connecting and disconnecting a Browserbase account.
 *
 * Two scopes, one flow. Which scope a key lands in is decided entirely by the
 * surface that accepted it — the owner-only organization settings, or a
 * member's own connections page — never by anything about the key, because
 * Browserbase authenticates by API key alone and its keys carry no
 * personal-vs-company signal.
 */

export type ConnectionScope = 'organization' | 'team' | 'user'

export type ConnectionSummary = {
  id: string
  scope: ConnectionScope
  userId: string | null
  /** Null for every connection made since the project id stopped being asked for. */
  projectId: string | null
  status: 'active' | 'needs_attention' | 'disabled'
  healthReason: string | null
  healthDetail: string | null
  createdAt: Date
  /** Live sessions right now, for the "is this being used" line. */
  liveSessions: number
  /** Minutes of browser time this connection has spent, all time. */
  usedMinutes: number
}

export type ConnectCloudBrowserInput = {
  organizationId: string
  scope: ConnectionScope
  /** Required for team scope, refused for the others. */
  teamId?: string | null
  /** Required for user scope, refused for the others. */
  userId: string | null
  actingUserId: string
  apiKey: string
  /**
   * Not asked for and not needed: Browserbase resolves the project from the
   * key. Accepted so an install that wants its sessions pinned to one
   * project can still say so.
   */
  projectId?: string | null
}

export type ConnectionDeps = {
  prisma: PrismaClient
  /** Writes the key into the encrypted store and returns a server-minted ref. */
  storeSecret: (prisma: PrismaClient | Prisma.TransactionClient, apiKey: string) => Promise<string>
  clientFactory?: (credentials: { apiKey: string; projectId?: string | null }) => BrowserbaseClient
}

export type CloudBrowserConnectionProbeDeps = Pick<ConnectionDeps, 'clientFactory'>

export type CloudBrowserConnectionPersistenceDeps = {
  prisma: Prisma.TransactionClient
  storeSecret: (apiKey: string) => Promise<string>
}

const browserbaseSecretRef = (ref: string): boolean => ref.startsWith('secret_browserbase_')

/**
 * Browserbase credentials are stored in the encrypted MCP secret table, but
 * are not MCP OAuth grants. Keeping this narrow delete here makes the
 * connection row and its opaque key reference one transactional lifecycle.
 */
const removeBrowserbaseSecret = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  ref: string,
): Promise<void> => {
  if (!browserbaseSecretRef(ref)) return
  await prisma.mcpOAuthSecret.deleteMany({ where: { ref } })
}

const lockConnectionScope = async (
  prisma: Prisma.TransactionClient,
  input: Pick<ConnectCloudBrowserInput, 'organizationId' | 'scope' | 'teamId' | 'userId'>,
): Promise<void> => {
  const teamId = input.scope === 'team' ? input.teamId ?? '' : ''
  const userId = input.scope === 'user' ? input.userId ?? '' : ''
  await prisma.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cloud-browser-connection:${input.organizationId}:${input.scope}:${teamId}:${userId}`}, 0))`,
  )
}

/**
 * Probe before persisting: create a session and immediately release it. A
 * connection that cannot open a browser is a dead toggle, and the DeepWater
 * precedent is to refuse loudly rather than store one and fail later at the
 * moment somebody actually needs it.
 */
export const probeCloudBrowserConnection = async (
  deps: CloudBrowserConnectionProbeDeps,
  credentials: { apiKey: string; projectId?: string | null },
): Promise<void> => {
  const client = deps.clientFactory
    ? deps.clientFactory(credentials)
    : createBrowserbaseClient(credentials)
  const session = await client.createSession({ timeoutSeconds: 60 })
  // Best-effort: a probe session that outlives this call is reaped by
  // Browserbase's own timeout, so a release failure must not fail the connect.
  await client.endSession(session.id).catch(() => undefined)
}

export const validateCloudBrowserConnectionInput = (
  input: ConnectCloudBrowserInput,
): void => {
  if (input.scope === 'team' && !input.teamId) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'A team connection needs a team.',
    )
  }
  if (input.scope === 'user' && !input.userId) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'A personal connection needs an owner.',
    )
  }
  if (input.scope !== 'user' && input.userId) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'A shared connection has no individual owner.',
    )
  }
}

/**
 * Store a key and create or repair its connection in the caller's transaction.
 * Callers probe first, then call this only after their own one-shot decision
 * has won; a card press therefore cannot rekey an account it failed to claim.
 */
export const persistCloudBrowserConnection = async (
  deps: CloudBrowserConnectionPersistenceDeps,
  input: ConnectCloudBrowserInput,
): Promise<{ id: string }> => {
  validateCloudBrowserConnectionInput(input)

  const userId = input.scope === 'user' ? input.userId : null
  const teamId = input.scope === 'team' ? input.teamId ?? null : null

  await lockConnectionScope(deps.prisma, input)

  const existing = await deps.prisma.cloudBrowserConnection.findFirst({
    where: { organizationId: input.organizationId, scope: input.scope, teamId, userId },
    select: { apiKeyRef: true, id: true, status: true },
  })

  if (existing) {
    const locked = await deps.prisma.$queryRaw<Array<{
      apiKeyRef: string
      id: string
      status: 'active' | 'disabled' | 'needs_attention'
    }>>(Prisma.sql`SELECT id, api_key_ref AS "apiKeyRef", status
      FROM cloud_browser_connections
      WHERE id = ${existing.id}::uuid
      FOR UPDATE`)
    const lockedConnection = locked[0]
    if (!lockedConnection) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
        'This Browserbase connection changed while it was being updated. Retry the connection.',
      )
    }
    const [liveSessions, durableBrowsers, retiringBrowsers] = await Promise.all([
      deps.prisma.cloudBrowserSession.count({
        where: { connectionId: lockedConnection.id, status: { in: [...BLOCKING_SESSION_STATUSES] } },
      }),
      deps.prisma.agentBrowser.count({ where: { connectionId: lockedConnection.id, status: 'active' } }),
      deps.prisma.agentBrowser.count({
        where: { connectionId: lockedConnection.id, status: { in: ['tombstoned', 'deleting'] } },
      }),
    ])
    if (liveSessions > 0 || retiringBrowsers > 0) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.CAPACITY,
        liveSessions > 0
          ? 'Close every open browser before replacing this Browserbase connection.'
          : 'A saved browser is still being cleared. Wait for its reset to finish before reconnecting.',
      )
    }
    if (lockedConnection.status === 'active' && durableBrowsers > 0) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.CAPACITY,
        'Disconnect first, then reconnect the Browserbase account that owns these saved sign-ins.',
      )
    }
    const apiKeyRef = await deps.storeSecret(input.apiKey)
    await deps.prisma.cloudBrowserConnection.update({
      where: { id: lockedConnection.id },
      data: {
        apiKeyRef,
        projectId: input.projectId ?? null,
        status: 'active',
        healthReason: null,
        healthDetail: null,
        healthCheckedAt: new Date(),
        healthRevision: { increment: 1 },
      },
    })
    await removeBrowserbaseSecret(deps.prisma, lockedConnection.apiKeyRef)
    return { id: lockedConnection.id }
  }

  const apiKeyRef = await deps.storeSecret(input.apiKey)
  const created = await deps.prisma.cloudBrowserConnection.create({
    data: {
      organizationId: input.organizationId,
      scope: input.scope,
      teamId,
      userId,
      projectId: input.projectId ?? null,
      apiKeyRef,
      createdByUserId: input.actingUserId,
      status: 'active',
      healthCheckedAt: new Date(),
    },
    select: { id: true },
  })
  return { id: created.id }
}

export const connectCloudBrowser = async (
  deps: ConnectionDeps,
  input: ConnectCloudBrowserInput,
): Promise<{ id: string }> => {
  validateCloudBrowserConnectionInput(input)
  await probeCloudBrowserConnection(deps, {
    apiKey: input.apiKey,
    projectId: input.projectId ?? null,
  })
  return deps.prisma.$transaction((tx) => persistCloudBrowserConnection({
    prisma: tx,
    storeSecret: (apiKey) => deps.storeSecret(tx, apiKey),
  }, input))
}

/**
 * What the caller may see: the organization connection (everyone — its
 * existence is what makes the tools available) and their own personal one.
 * Never another member's.
 */
export const listCloudBrowserConnections = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<ConnectionSummary[]> => {
  const rows = await prisma.cloudBrowserConnection.findMany({
    where: {
      organizationId: input.organizationId,
      OR: [{ scope: 'organization' }, { scope: 'user', userId: input.userId }],
    },
    select: {
      id: true,
      scope: true,
      userId: true,
      projectId: true,
      status: true,
      healthReason: true,
      healthDetail: true,
      createdAt: true,
    },
    orderBy: { scope: 'asc' },
  })
  if (rows.length === 0) return []

  const usage = await prisma.cloudBrowserSession.groupBy({
    by: ['connectionId'],
    where: { connectionId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  })
  const live = await prisma.cloudBrowserSession.groupBy({
    by: ['connectionId'],
    where: {
      connectionId: { in: rows.map((row) => row.id) },
      status: { in: [...BLOCKING_SESSION_STATUSES] },
    },
    _count: { _all: true },
  })
  const sessions = await prisma.cloudBrowserSession.findMany({
    where: { connectionId: { in: rows.map((row) => row.id) }, endedAt: { not: null } },
    select: { connectionId: true, startedAt: true, endedAt: true },
  })

  const minutesByConnection = new Map<string, number>()
  for (const session of sessions) {
    if (!session.endedAt) continue
    const elapsed = session.endedAt.getTime() - session.startedAt.getTime()
    // Browserbase bills a minimum of one minute per created session, so a
    // 5-second visit that reports 0.08 would understate the real allowance.
    const minutes = Math.max(1, Math.ceil(elapsed / 60_000))
    minutesByConnection.set(
      session.connectionId,
      (minutesByConnection.get(session.connectionId) ?? 0) + minutes,
    )
  }

  const liveByConnection = new Map(live.map((row) => [row.connectionId, row._count._all]))
  void usage

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    userId: row.userId,
    projectId: row.projectId,
    status: row.status,
    healthReason: row.healthReason,
    healthDetail: row.healthDetail,
    createdAt: row.createdAt,
    liveSessions: liveByConnection.get(row.id) ?? 0,
    usedMinutes: minutesByConnection.get(row.id) ?? 0,
  }))
}

/**
 * Disconnecting refuses while browsers are still open on this connection,
 * because deleting the row takes the API key with it and nothing could then
 * tell Browserbase to stop them — they would bill until their own timeout.
 */
export const disconnectCloudBrowser = async (
  prisma: PrismaClient,
  input: { organizationId: string; connectionId: string },
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ apiKeyRef: string; id: string }>>(
      Prisma.sql`SELECT id, api_key_ref AS "apiKeyRef"
        FROM cloud_browser_connections
        WHERE id = ${input.connectionId}::uuid
          AND organization_id = ${input.organizationId}::uuid
        FOR UPDATE`,
    )
    const row = rows[0]
    if (!row) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
        'That browser connection does not exist.',
      )
    }
    const [live, retiringBrowsers] = await Promise.all([
      tx.cloudBrowserSession.count({
        where: { connectionId: row.id, status: { in: [...BLOCKING_SESSION_STATUSES] } },
      }),
      tx.agentBrowser.count({
        where: { connectionId: row.id, status: { in: ['tombstoned', 'deleting'] } },
      }),
    ])
    if (live > 0) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.CAPACITY,
        `${live} browser${live === 1 ? ' is' : 's are'} still open on this connection. `
        + 'Close them, or wait for their runs to finish, before disconnecting.',
      )
    }
    if (retiringBrowsers > 0) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.CAPACITY,
        'A saved browser is still being cleared. Wait for its reset to finish before disconnecting.',
      )
    }
    await tx.cloudBrowserConnection.update({
      where: { id: row.id },
      data: {
        status: 'disabled',
        healthReason: 'disabled_by_owner',
        healthDetail: 'Disconnected by its owner.',
        healthCheckedAt: new Date(),
        healthRevision: { increment: 1 },
      },
    })
    await removeBrowserbaseSecret(tx, row.apiKeyRef)
  })
}

export const describeConnectError = (error: unknown): { code: string; message: string } => {
  if (isCloudBrowserError(error)) return { code: error.code, message: error.message }
  return {
    code: CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
    message: (error as Error).message,
  }
}
