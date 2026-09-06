import { Prisma, type PrismaClient } from '@prisma/client'
import { resolveScopedSetting } from '@nessie/runtime'

import type { ConnectionScope } from './connection-management.js'

import {
  createBrowserbaseClient,
  type BrowserbaseClient,
  type BrowserbaseCredentials,
} from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'
import { captureTabsAtConnectUrl } from './agent-browser-tabs.js'
import type { CdpClient } from './cdp-client.js'
import { loadSessionCapability, sealConnectCapability } from './session-capability.js'

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
  /**
   * The deployment auth secret, which unseals a session's connect capability.
   * Needed to capture a resumed session's tabs before it is released, since no
   * worker holds a socket to it; absent, that capture is skipped.
   */
  encryptionSecret?: string
  /** Test seam. */
  clientFactory?: (credentials: BrowserbaseCredentials) => BrowserbaseClient
  /** Test seam for the capture that dials a resumed session itself. */
  connect?: (connectUrl: string) => Promise<CdpClient>
  now?: () => Date
}

export type ResolvedConnection = {
  id: string
  scope: ConnectionScope
  /** Null unless this connection was made before the project id was dropped. */
  projectId: string | null
  apiKeyRef: string
}


/** Outermost first, matching the setting cascade's own order. */
const CONNECTION_SCOPE_ORDER: readonly ConnectionScope[] = ['organization', 'team', 'user']

/** The cascade key that governs which account an agent's browser runs on. */
export const CLOUD_BROWSER_SETTING_KEY = 'browser.connection'

/** Statuses that hold the one-live-session-per-run partial unique index. */
export const LIVE_SESSION_STATUSES = ['allocating', 'active', 'releasing'] as const

const DEFAULT_TTL_MS = 10 * 60 * 1000
/**
 * A session a person resumed from the chat has no run to end it. It lives on
 * this idle window instead, extended by every read of its live view while the
 * column is open, and capped at the ordinary TTL so a tab left open in a
 * forgotten window cannot bill past what a run could.
 */
const DEFAULT_RESUME_IDLE_MS = 5 * 60 * 1000
/** A deployment ceiling the model can never argue past. */
const MAX_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_CONCURRENT = 3

export const cloudBrowserSettings = (env: NodeJS.ProcessEnv = process.env): {
  ttlMs: number
  resumeIdleMs: number
  maxConcurrent: number
} => {
  const ttl = Number(env.NESSIE_BROWSER_CLOUD_TTL_MS ?? DEFAULT_TTL_MS)
  const idle = Number(env.NESSIE_BROWSER_CLOUD_RESUME_IDLE_MS ?? DEFAULT_RESUME_IDLE_MS)
  const concurrent = Number(env.NESSIE_BROWSER_CLOUD_MAX_CONCURRENT ?? DEFAULT_MAX_CONCURRENT)
  const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_TTL_MS) : DEFAULT_TTL_MS
  return {
    ttlMs,
    resumeIdleMs:
      Number.isFinite(idle) && idle > 0 ? Math.min(idle, ttlMs) : Math.min(DEFAULT_RESUME_IDLE_MS, ttlMs),
    maxConcurrent:
      Number.isFinite(concurrent) && concurrent > 0 ? concurrent : DEFAULT_MAX_CONCURRENT,
  }
}

/**
 * The most specific connection the run can reach — a person's own account over
 * their team's, a team's over the organisation's — unless a level above has
 * locked `browser.connection`, in which case that level's account is what
 * everyone below uses. This is the one shared cascade
 * (`@nessie/runtime` `resolveScopedSetting`), not a second ordering rule
 * hardcoded here: it used to prefer the organisation unconditionally, which an
 * owner could neither see nor change.
 *
 * An unattended run has no requester, so it never reaches a personal account —
 * a schedule must not spend an individual's browser-hours. A team account is
 * shared, so it may.
 */
export const resolveConnectionForRun = async (
  prisma: Pick<PrismaClient, 'cloudBrowserConnection' | 'scopedSetting'>,
  input: {
    organizationId: string
    teamId: string | null
    requestedByUserId: string | null
  },
): Promise<ResolvedConnection | null> => {
  const [rows, setting] = await Promise.all([
    prisma.cloudBrowserConnection.findMany({
      where: {
        organizationId: input.organizationId,
        status: 'active',
        OR: [
          { scope: 'organization' },
          ...(input.teamId ? [{ scope: 'team' as const, teamId: input.teamId }] : []),
          ...(input.requestedByUserId
            ? [{ scope: 'user' as const, userId: input.requestedByUserId }]
            : []),
        ],
      },
      select: { id: true, scope: true, projectId: true, apiKeyRef: true, userId: true },
    }),
    resolveScopedSetting(prisma, {
      organizationId: input.organizationId,
      teamId: input.teamId,
      userId: input.requestedByUserId,
    }, CLOUD_BROWSER_SETTING_KEY),
  ])

  // Walk inwards and keep the last account we are still allowed to reach. The
  // lock stops the walk at the level that set it, exactly as the cascade
  // resolves any other setting.
  const byScope = new Map(rows.map((row) => [row.scope as ConnectionScope, row]))
  let chosen: (typeof rows)[number] | undefined
  for (const scope of CONNECTION_SCOPE_ORDER) {
    chosen = byScope.get(scope) ?? chosen
    if (setting.lockedAtScope === scope) break
  }
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
  /**
   * Null when a person resumed the browser from the conversation: no run will
   * end it, so it gets the idle TTL rather than the run TTL.
   */
  runId: string | null
  threadId: string
  agentId: string
  /**
   * The deployment auth secret. The connect URL is sealed with it and written
   * beside the `active` flip, so a worker that did not open this session can
   * still re-attach — see `session-capability.ts`.
   */
  encryptionSecret: string
  /**
   * The cross-origin write gate to store with it, serialised by the caller
   * (the worker owns its shape). An `active` row always carries one, so a
   * re-attaching worker can tell "no gate persisted" — which escalates — from
   * "a gate that permits this".
   */
  originGate: Prisma.InputJsonValue
  /** The channel's team, which is one level of the connection cascade. */
  teamId: string | null
  requestedByUserId: string | null
  /**
   * Ride the agent's durable browser instead of a throwaway session. The
   * caller resolves it (connection rules live in `agent-browser.ts`); this
   * module only enforces one live session per browser and marks the session
   * authenticated when the browser already carries human logins.
   */
  agentBrowser?: {
    id: string
    connectionId: string
    browserbaseContextId: string
    /** Any recorded login makes every read through it that person's material. */
    hasLogins: boolean
  }
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
  const expiresAt = new Date(
    now.getTime() + (input.runId === null ? settings.resumeIdleMs : settings.ttlMs),
  )

  // Checked before anything is claimed or created: sealing the connect URL is
  // not optional — a session nobody but this process can re-attach to is the
  // defect this argument exists to close — and a deployment missing the secret
  // must find out before it has paid for a browser it cannot hand on.
  if (!input.encryptionSecret) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'This deployment has no auth secret configured, so a cloud browser session '
        + 'cannot be stored for other workers to resume. Set NESSIE_AUTH_SECRET.',
    )
  }

  // A durable browser dictates its own connection: its context belongs to
  // the account that created it and cannot be opened with another key.
  const connection = input.agentBrowser
    ? await deps.prisma.cloudBrowserConnection.findFirst({
      where: {
        id: input.agentBrowser.connectionId,
        organizationId: input.organizationId,
        status: 'active',
        // An unattended run has no requester, so it may only ever ride a
        // shared account — a schedule must not bill somebody's personal
        // account, however its agent's browser came to live there. A team
        // account is shared, so it qualifies alongside the organisation's.
        ...(input.requestedByUserId
          ? {}
          : { scope: { in: ['organization', 'team'] as const } }),
      },
      select: { id: true, scope: true, projectId: true, apiKeyRef: true },
    })
    : await resolveConnectionForRun(deps.prisma, {
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      teamId: input.teamId,
    })
  if (!connection) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      input.agentBrowser
        ? 'This agent’s browser lives on an account this run may not use — a '
          + 'scheduled run can only use the organisation’s account.'
        : 'No Browserbase account is connected for this team.',
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
          `This team already has ${live} cloud browsers open. Close one and retry.`,
        )
      }
      if (input.agentBrowser) {
        // Inside the same transaction as the claim: a reset between the
        // caller's `ensureAgentBrowser` read and this insert would otherwise
        // let the reconciler delete the context under a live session.
        const stillActive = await tx.agentBrowser.count({
          where: { id: input.agentBrowser.id, status: 'active' },
        })
        if (stillActive !== 1) {
          throw new CloudBrowserError(
            CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
            'This agent’s browser was reset. Open it again to get a fresh one.',
          )
        }
      }
      const created = await tx.cloudBrowserSession.create({
        data: {
          organizationId: input.organizationId,
          connectionId: connection.id,
          runId: input.runId,
          threadId: input.threadId,
          agentId: input.agentId,
          requestedByUserId: input.requestedByUserId,
          agentBrowserId: input.agentBrowser?.id ?? null,
          // Monotone from the first moment: a browser carrying somebody's
          // login makes everything read through it their material, and this
          // must be true before any page is fetched, not after.
          authenticated: input.agentBrowser?.hasLogins ?? false,
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
      // Two different collisions, and the difference matters to the model:
      // its own run already holds one, or another run of the same agent is
      // using the shared durable browser and it should wait or go ephemeral.
      const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '')
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.SESSION_ALREADY_OPEN,
        target.includes('agent_browser')
          ? 'This agent’s browser is already open in another run. Wait for it to finish, or open a throwaway browser instead.'
          : 'This run already has a cloud browser open. Close it before opening another.',
      )
    }
    throw error
  }

  try {
    const client = await loadClient(deps, connection)
    const session = await client.createSession({
      // The hard cap, for a resumed session too: its idle window is enforced
      // by the reaper and extended while somebody watches, and the remote
      // timeout must leave room for that.
      timeoutSeconds: Math.ceil(settings.ttlMs / 1000),
      ...(input.agentBrowser
        // `persist` is what makes tomorrow's run find the login still there.
        ? { contextId: input.agentBrowser.browserbaseContextId, persistContext: true }
        : {}),
    })
    if (input.agentBrowser) {
      await deps.prisma.agentBrowser
        .update({ where: { id: input.agentBrowser.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined)
    }
    // One statement, so a row is never `active` without the capability that
    // makes it drivable from another worker (audit 8.1).
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: rowId, status: 'allocating' },
      data: {
        status: 'active',
        browserbaseSessionId: session.id,
        connectCapabilityCiphertext: sealConnectCapability(
          input.encryptionSecret,
          session.connectUrl,
        ),
        originGate: input.originGate,
      },
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

/**
 * Keep a resumed session alive while somebody is watching it.
 *
 * Called from the read that mints its live view, which the column polls only
 * while it is open — so closing the column is what lets the session lapse. The
 * extension never passes `startedAt + ttlMs`: a forgotten window keeps
 * polling, and without the cap it would keep paying.
 */
export const touchResumedSession = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  input: { sessionId: string; now?: Date },
): Promise<void> => {
  const settings = cloudBrowserSettings()
  const now = input.now ?? new Date()
  const row = await prisma.cloudBrowserSession.findFirst({
    where: { id: input.sessionId, runId: null, status: { in: [...LIVE_SESSION_STATUSES] } },
    select: { startedAt: true, expiresAt: true },
  })
  if (!row) return
  const cap = new Date(row.startedAt.getTime() + settings.ttlMs)
  const next = new Date(Math.min(now.getTime() + settings.resumeIdleMs, cap.getTime()))
  if (next.getTime() <= row.expiresAt.getTime()) return
  await prisma.cloudBrowserSession.updateMany({
    where: { id: input.sessionId, runId: null, status: { in: [...LIVE_SESSION_STATUSES] } },
    data: { expiresAt: next },
  })
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
      // `unknown` is included on purpose: it is the state a failed remote stop
      // leaves behind, and it is exactly the row most likely to still be
      // costing money.
      status: { in: [...LIVE_SESSION_STATUSES, 'unknown'] },
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


/**
 * How long a control claim survives without a heartbeat. A closed laptop lid
 * must not hold a team's browser hostage, and the claimant's viewer renews
 * this while it is open.
 */
export const CONTROL_CLAIM_TTL_MS = 90_000

/**
 * Take the controls.
 *
 * One winner by conditional UPDATE, the claim-once discipline: a session can
 * render to many entitled viewers at once, so two people pressing together
 * must not both believe they are driving. An expired claim is reclaimable,
 * which is what stops a dropped connection stranding the browser.
 */
export const claimSessionControl = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  input: { sessionId: string; userId: string; now?: Date },
): Promise<boolean> => {
  const now = input.now ?? new Date()
  const staleBefore = new Date(now.getTime() - CONTROL_CLAIM_TTL_MS)
  const claimed = await prisma.cloudBrowserSession.updateMany({
    where: {
      id: input.sessionId,
      status: { in: [...LIVE_SESSION_STATUSES] },
      OR: [
        { controlledByUserId: null },
        // Renewing your own claim, or taking over one nobody has refreshed.
        { controlledByUserId: input.userId },
        { controlClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { controlledByUserId: input.userId, controlClaimedAt: now },
  })
  return claimed.count === 1
}

/**
 * Hand the browser back. Only the holder can, so a bystander cannot yank the
 * controls out from under somebody mid-sign-in.
 */
export const releaseSessionControl = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession' | 'agentBrowserLogin'>,
  input: { sessionId: string; userId: string },
): Promise<boolean> => {
  const session = await prisma.cloudBrowserSession.findFirst({
    where: { id: input.sessionId, controlledByUserId: input.userId },
    select: { agentBrowserId: true, organizationId: true },
  })
  const released = await prisma.cloudBrowserSession.updateMany({
    where: { id: input.sessionId, controlledByUserId: input.userId },
    data: {
      controlledByUserId: null,
      controlClaimedAt: null,
      // A person at the controls may have signed in — that is much of why
      // anybody takes them — and the agent resumes into whatever they left
      // behind. Marking the session authenticated on hand-back is the only
      // way the run's disclosure basis can be right afterwards; it is
      // monotone, so an unnecessary mark only ever over-restricts.
      authenticated: true,
    },
  })
  if (released.count !== 1) return false

  // The durable browser keeps whatever they left behind, so the record has to
  // outlive the session: without it, tomorrow's run reads `loginCount === 0`
  // and publishes what it reads to everyone. The service is unnamed because
  // nobody asked. One row per person per browser: a person who resumes the
  // browser to look, then to look again, is the same audit fact twice, and a
  // sign-in card's Done already writes the named row for a real handoff.
  if (session?.agentBrowserId) {
    const already = await prisma.agentBrowserLogin.count({
      where: { agentBrowserId: session.agentBrowserId, userId: input.userId },
    })
    if (already === 0) {
      await prisma.agentBrowserLogin.create({
        data: {
          agentBrowserId: session.agentBrowserId,
          organizationId: session.organizationId,
          serviceHint: 'Signed in while at the controls',
          userId: input.userId,
        },
      }).catch(() => undefined)
    }
  }
  return true
}

/**
 * Drop claims nobody has refreshed, so the agent can resume on its own rather
 * than waiting for a person who has gone.
 */
export const expireStaleControlClaims = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  now: Date = new Date(),
): Promise<number> => {
  const expired = await prisma.cloudBrowserSession.updateMany({
    where: {
      controlledByUserId: { not: null },
      controlClaimedAt: { lt: new Date(now.getTime() - CONTROL_CLAIM_TTL_MS) },
    },
    data: { controlledByUserId: null, controlClaimedAt: null },
  })
  return expired.count
}
