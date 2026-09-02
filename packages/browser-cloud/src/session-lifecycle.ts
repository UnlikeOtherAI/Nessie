import { Prisma, type PrismaClient } from '@prisma/client'

import {
  createBrowserbaseClient,
  type BrowserbaseClient,
  type BrowserbaseCredentials,
} from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'

/**
 * Connection resolution and the session state machine.
 *
 * Browser-hours are money, so nothing here treats a remote session as a
 * boolean. A create that times out may still have produced a paid session,
 * which is why the row is written `allocating` *before* the remote call and
 * only reaches `active` once Browserbase has confirmed an id.
 */

export type SecretResolve = (ref: string) => Promise<string | null>

export type CloudBrowserDeps = {
  prisma: PrismaClient
  resolveSecret: SecretResolve
  /** Test seam. */
  clientFactory?: (credentials: BrowserbaseCredentials) => BrowserbaseClient
  now?: () => Date
}

export type ResolvedConnection = {
  id: string
  scope: 'organization' | 'user'
  projectId: string
  apiKeyRef: string
}

/** Statuses that hold the one-live-session-per-run partial unique index. */
export const LIVE_SESSION_STATUSES = ['allocating', 'active', 'releasing'] as const

const DEFAULT_TTL_MS = 10 * 60 * 1000
/** A deployment ceiling the model can never argue past. */
const MAX_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_CONCURRENT = 3

export const cloudBrowserSettings = (env: NodeJS.ProcessEnv = process.env): {
  ttlMs: number
  maxConcurrent: number
} => {
  const ttl = Number(env.NESSIE_BROWSER_CLOUD_TTL_MS ?? DEFAULT_TTL_MS)
  const concurrent = Number(env.NESSIE_BROWSER_CLOUD_MAX_CONCURRENT ?? DEFAULT_MAX_CONCURRENT)
  return {
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_TTL_MS) : DEFAULT_TTL_MS,
    maxConcurrent:
      Number.isFinite(concurrent) && concurrent > 0 ? concurrent : DEFAULT_MAX_CONCURRENT,
  }
}

/**
 * The organization subscription first, then the requesting person's own
 * account. An unattended run has no requester, so it can only ever use the
 * organization connection — a schedule must never spend an individual's
 * browser-hours.
 */
export const resolveConnectionForRun = async (
  prisma: Pick<PrismaClient, 'cloudBrowserConnection'>,
  input: { organizationId: string; requestedByUserId: string | null },
): Promise<ResolvedConnection | null> => {
  const rows = await prisma.cloudBrowserConnection.findMany({
    where: {
      organizationId: input.organizationId,
      status: 'active',
      OR: [
        { scope: 'organization' },
        ...(input.requestedByUserId
          ? [{ scope: 'user' as const, userId: input.requestedByUserId }]
          : []),
      ],
    },
    select: { id: true, scope: true, projectId: true, apiKeyRef: true, userId: true },
  })
  const organization = rows.find((row) => row.scope === 'organization')
  const personal = rows.find((row) => row.scope === 'user')
  const chosen = organization ?? personal
  if (!chosen) return null
  return {
    id: chosen.id,
    scope: chosen.scope,
    projectId: chosen.projectId,
    apiKeyRef: chosen.apiKeyRef,
  }
}

const loadClient = async (
  deps: CloudBrowserDeps,
  connection: ResolvedConnection,
): Promise<BrowserbaseClient> => {
  const apiKey = await deps.resolveSecret(connection.apiKeyRef)
  if (!apiKey) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED,
      'The stored Browserbase key could not be read. Reconnect the account.',
    )
  }
  const credentials = { apiKey, projectId: connection.projectId }
  return deps.clientFactory
    ? deps.clientFactory(credentials)
    : createBrowserbaseClient(credentials)
}

/**
 * A capability that can stop working owns the way a person finds out: a
 * rejected key claims `needs_attention` with a persisted reason, so the
 * surface can name the remedy and the toolset stops advertising a browser.
 * The transition is a conditional UPDATE, so concurrent failures alert once.
 */
export const markConnectionNeedsAttention = async (
  prisma: Pick<PrismaClient, 'cloudBrowserConnection'>,
  input: { connectionId: string; reason: string; detail: string },
): Promise<boolean> => {
  const updated = await prisma.cloudBrowserConnection.updateMany({
    where: { id: input.connectionId, status: 'active' },
    data: {
      status: 'needs_attention',
      healthReason: input.reason,
      healthDetail: input.detail.slice(0, 500),
      healthCheckedAt: new Date(),
      healthRevision: { increment: 1 },
    },
  })
  return updated.count === 1
}

export type OpenSessionInput = {
  organizationId: string
  runId: string
  threadId: string
  agentId: string
  requestedByUserId: string | null
  /** Optional starting URL, navigated after attach. */
  url?: string
}

export type OpenSessionResult = {
  sessionId: string
  browserbaseSessionId: string
  connectUrl: string
  expiresAt: Date
}

/**
 * Claim a session row, then create the remote browser.
 *
 * The row is inserted first precisely so the claim is atomic: the
 * one-live-session-per-run partial unique index refuses a second concurrent
 * open, and the concurrency cap is counted under an advisory lock rather than
 * read-then-written (a count-then-insert admits N past the cap under fan-out).
 */
export const openCloudBrowserSession = async (
  deps: CloudBrowserDeps,
  input: OpenSessionInput,
): Promise<OpenSessionResult> => {
  const settings = cloudBrowserSettings()
  const now = deps.now?.() ?? new Date()
  const expiresAt = new Date(now.getTime() + settings.ttlMs)

  const connection = await resolveConnectionForRun(deps.prisma, {
    organizationId: input.organizationId,
    requestedByUserId: input.requestedByUserId,
  })
  if (!connection) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'No Browserbase account is connected for this workspace.',
    )
  }

  let rowId: string
  try {
    rowId = await deps.prisma.$transaction(async (tx) => {
      // Serialize the cap check against concurrent opens in this organization.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cloud-browser:${input.organizationId}`}, 0))`,
      )
      const live = await tx.cloudBrowserSession.count({
        where: {
          organizationId: input.organizationId,
          status: { in: [...LIVE_SESSION_STATUSES] },
        },
      })
      if (live >= settings.maxConcurrent) {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.CAPACITY,
          `This workspace already has ${live} cloud browsers open. Close one and retry.`,
        )
      }
      const created = await tx.cloudBrowserSession.create({
        data: {
          organizationId: input.organizationId,
          connectionId: connection.id,
          runId: input.runId,
          threadId: input.threadId,
          agentId: input.agentId,
          requestedByUserId: input.requestedByUserId,
          status: 'allocating',
          expiresAt,
        },
        select: { id: true },
      })
      return created.id
    })
  } catch (error) {
    if (isCloudBrowserError(error)) throw error
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === 'P2002'
    ) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.SESSION_ALREADY_OPEN,
        'This run already has a cloud browser open. Close it before opening another.',
      )
    }
    throw error
  }

  try {
    const client = await loadClient(deps, connection)
    const session = await client.createSession({
      timeoutSeconds: Math.ceil(settings.ttlMs / 1000),
    })
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: rowId, status: 'allocating' },
      data: { status: 'active', browserbaseSessionId: session.id },
    })
    return {
      sessionId: rowId,
      browserbaseSessionId: session.id,
      connectUrl: session.connectUrl,
      expiresAt,
    }
  } catch (error) {
    // The remote create failed or is unproven. Leave the row terminal so it
    // stops holding the run's live slot, and record why.
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: rowId },
      data: {
        status: 'failed',
        endedAt: new Date(),
        releasedBy: 'open_failed',
        lastError: (error as Error).message.slice(0, 500),
      },
    })
    if (isCloudBrowserError(error) && error.code === CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED) {
      await markConnectionNeedsAttention(deps.prisma, {
        connectionId: connection.id,
        reason: 'auth_failed',
        detail: error.message,
      })
    }
    throw error
  }
}

export type LiveSessionRow = {
  id: string
  browserbaseSessionId: string | null
  connectionId: string
  status: string
  expiresAt: Date
  controlledByUserId: string | null
  authenticated: boolean
}

export const findLiveSessionForRun = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  runId: string,
): Promise<LiveSessionRow | null> =>
  prisma.cloudBrowserSession.findFirst({
    where: { runId, status: { in: [...LIVE_SESSION_STATUSES] } },
    select: {
      id: true,
      browserbaseSessionId: true,
      connectionId: true,
      status: true,
      expiresAt: true,
      controlledByUserId: true,
      authenticated: true,
    },
  })

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
  input: { sessionId: string; releasedBy: string },
): Promise<boolean> => {
  const claimed = await deps.prisma.cloudBrowserSession.updateMany({
    where: { id: input.sessionId, status: { in: [...LIVE_SESSION_STATUSES] } },
    data: { status: 'releasing' },
  })
  if (claimed.count !== 1) return false

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
  const rows = await deps.prisma.cloudBrowserSession.findMany({
    where: { runId: input.runId, status: { in: [...LIVE_SESSION_STATUSES] } },
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
  const rows = await deps.prisma.cloudBrowserSession.findMany({
    where: {
      status: { in: [...LIVE_SESSION_STATUSES] },
      expiresAt: { lte: now },
    },
    select: { id: true },
    take: options.limit ?? 20,
    orderBy: { expiresAt: 'asc' },
  })
  let reaped = 0
  for (const row of rows) {
    if (await releaseCloudBrowserSession(deps, {
      sessionId: row.id,
      releasedBy: 'reaper',
    })) {
      reaped += 1
    }
  }
  return reaped
}

/**
 * Mark a session as carrying a human's authenticated state. Monotone: it
 * never clears within a session, which is what makes the disclosure basis
 * safe to evaluate on every read rather than recomputed per page.
 */
export const markSessionAuthenticated = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  sessionId: string,
): Promise<void> => {
  await prisma.cloudBrowserSession.updateMany({
    where: { id: sessionId, authenticated: false },
    data: { authenticated: true },
  })
}
