import type { PrismaClient } from '@prisma/client'

import { createBrowserbaseClient, type BrowserbaseClient } from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'

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
  projectId: string
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
  /** Required for user scope, refused for organization scope. */
  userId: string | null
  actingUserId: string
  apiKey: string
  projectId: string
}

export type ConnectionDeps = {
  prisma: PrismaClient
  /** Writes the key into the encrypted store and returns a server-minted ref. */
  storeSecret: (apiKey: string) => Promise<string>
  clientFactory?: (credentials: { apiKey: string; projectId: string }) => BrowserbaseClient
}

/**
 * Probe before persisting: create a session and immediately release it. A
 * connection that cannot open a browser is a dead toggle, and the DeepWater
 * precedent is to refuse loudly rather than store one and fail later at the
 * moment somebody actually needs it.
 */
const probe = async (
  deps: ConnectionDeps,
  credentials: { apiKey: string; projectId: string },
): Promise<void> => {
  const client = deps.clientFactory
    ? deps.clientFactory(credentials)
    : createBrowserbaseClient(credentials)
  const session = await client.createSession({ timeoutSeconds: 60 })
  // Best-effort: a probe session that outlives this call is reaped by
  // Browserbase's own timeout, so a release failure must not fail the connect.
  await client.endSession(session.id).catch(() => undefined)
}

export const connectCloudBrowser = async (
  deps: ConnectionDeps,
  input: ConnectCloudBrowserInput,
): Promise<{ id: string }> => {
  if (input.scope === 'user' && !input.userId) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'A personal connection needs an owner.',
    )
  }
  if (input.scope === 'organization' && input.userId) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'An organization connection has no individual owner.',
    )
  }

  await probe(deps, { apiKey: input.apiKey, projectId: input.projectId })

  // Only now does the plaintext reach the store, and only a `secret_*` ref is
  // persisted on the row — the key itself never returns to any caller.
  const apiKeyRef = await deps.storeSecret(input.apiKey)
  const userId = input.scope === 'user' ? input.userId : null

  const existing = await deps.prisma.cloudBrowserConnection.findFirst({
    where: { organizationId: input.organizationId, scope: input.scope, userId },
    select: { id: true },
  })

  if (existing) {
    // Replacing a key is also the repair path for `needs_attention`, so the
    // status resets and the health reason clears in the same write.
    await deps.prisma.cloudBrowserConnection.update({
      where: { id: existing.id },
      data: {
        apiKeyRef,
        projectId: input.projectId,
        status: 'active',
        healthReason: null,
        healthDetail: null,
        healthCheckedAt: new Date(),
        healthRevision: { increment: 1 },
      },
    })
    return { id: existing.id }
  }

  const created = await deps.prisma.cloudBrowserConnection.create({
    data: {
      organizationId: input.organizationId,
      scope: input.scope,
      userId,
      projectId: input.projectId,
      apiKeyRef,
      createdByUserId: input.actingUserId,
      status: 'active',
      healthCheckedAt: new Date(),
    },
    select: { id: true },
  })
  return { id: created.id }
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
      status: { in: ['allocating', 'active', 'releasing'] },
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
  const row = await prisma.cloudBrowserConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { id: true },
  })
  if (!row) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'That browser connection does not exist.',
    )
  }
  const live = await prisma.cloudBrowserSession.count({
    where: {
      connectionId: input.connectionId,
      status: { in: ['allocating', 'active', 'releasing'] },
    },
  })
  if (live > 0) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.CAPACITY,
      `${live} browser${live === 1 ? ' is' : 's are'} still open on this connection. `
      + 'Close them, or wait for their runs to finish, before disconnecting.',
    )
  }
  await prisma.cloudBrowserConnection.delete({ where: { id: input.connectionId } })
}

export const describeConnectError = (error: unknown): { code: string; message: string } => {
  if (isCloudBrowserError(error)) return { code: error.code, message: error.message }
  return {
    code: CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
    message: (error as Error).message,
  }
}
