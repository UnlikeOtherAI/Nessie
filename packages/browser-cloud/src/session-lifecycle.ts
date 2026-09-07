import { Prisma, type PrismaClient } from '@prisma/client'
import { DEFAULT_BROWSER_VIEWPORT, type BrowserViewport } from '@nessie/schemas'

import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'
import { loadSessionCapability, sealConnectCapability } from './session-capability.js'
import {
  BLOCKING_SESSION_STATUSES,
  LIVE_SESSION_STATUSES,
  cloudBrowserSettings,
  loadClient,
  markConnectionNeedsAttention,
  resolveConnectionForRun,
  type CloudBrowserDeps,
  type ResolvedConnection,
} from './session-foundation.js'


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
  /** A validated connection for a narrowly scoped package lifecycle. */
  connectionOverride?: ResolvedConnection
  /**
   * A caller-authored deadline. It can be no later than the deployment's hard
   * session TTL; a no-run session must not substitute the ordinary resume-idle
   * window for this explicit task ceiling.
   */
  expiresAt?: Date
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
    /** Set while a person's hand-back is recent enough to act on. */
    handedBackByUserId?: string | null
    /**
     * The window this browser opens at, from its own row. Required rather
     * than optional on purpose: Browserbase fixes the window at creation and
     * never again, so a call site that forgot to pass one would open the
     * browser at the wrong size for its whole life with nothing to notice it.
     * Making it required is what has tsc name every construction site the
     * moment a new one appears.
     */
    viewport: BrowserViewport
  }
  /** Optional starting URL, navigated after attach. */
  url?: string
  /** A fresh no-context session may have its own structural viewport. */
  viewport?: BrowserViewport
}

/**
 * The window a session opens at. A throwaway browser has no row to remember a
 * size, so it gets the same laptop window a never-sized durable browser does —
 * one default, stated once, rather than each path inventing its own.
 */
const viewportForSession = (input: OpenSessionInput): BrowserViewport =>
  input.viewport ?? input.agentBrowser?.viewport ?? DEFAULT_BROWSER_VIEWPORT

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
  const hardExpiresAt = new Date(now.getTime() + settings.ttlMs)
  const defaultExpiresAt = input.runId === null
    ? new Date(now.getTime() + settings.resumeIdleMs)
    : hardExpiresAt
  const expiresAt = input.expiresAt
    ? new Date(Math.min(input.expiresAt.getTime(), hardExpiresAt.getTime()))
    : defaultExpiresAt
  if (expiresAt <= now) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.EXPIRED, 'This browser access has expired.')
  }

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
  const connection = input.connectionOverride ?? (input.agentBrowser
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
    }))
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
          status: { in: [...BLOCKING_SESSION_STATUSES] },
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
          interactionTransport: 'mediated',
          viewportWidth: viewportForSession(input).width,
          viewportHeight: viewportForSession(input).height,
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
      // A session with no run is one a person opened, and nothing holds its
      // socket between the restore and the moment the live view's iframe
      // dials in. Browserbase stops a session when its last connection drops,
      // so without this the browser is gone before anybody can watch it — the
      // reaper and the idle TTL remain what actually ends it.
      keepAlive: input.runId === null,
      viewport: viewportForSession(input),
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
/**
 * Take over the browser a person just handed back, instead of opening another.
 *
 * Done releases the claim and leaves the session up precisely so the agent can
 * carry on without a cold start — but the session was opened by a person, so
 * it carries no `run_id` and `findLiveSessionForRun` cannot see it. Opening a
 * second one is refused by the one-live-session-per-browser rule, which is how
 * "the agent picks the task back up" turned into "this agent's browser is
 * already open in another run".
 *
 * So the run adopts it: one conditional update that both claims the session and
 * proves nobody else did first. `run_id IS NULL` in the WHERE is the whole
 * concurrency story — two runs racing to adopt, or a person re-taking the
 * controls in between, and the loser simply opens its own browser.
 */
export const adoptHandedBackSession = async (
  deps: CloudBrowserDeps,
  input: { agentBrowserId: string; runId: string; encryptionSecret: string },
): Promise<{ sessionId: string; connectUrl: string } | null> => {
  const candidate = await deps.prisma.cloudBrowserSession.findFirst({
    where: {
      agentBrowserId: input.agentBrowserId,
      runId: null,
      status: 'active',
      expiresAt: { gt: new Date() },
      // Somebody has taken the controls again since the hand-back. Their claim
      // is the answer; the agent waits rather than driving underneath them.
      controlledByUserId: null,
    },
    select: { id: true },
  })
  if (!candidate) return null
  // A fresh window, not the person's leftovers. The resumed session was on the
  // short idle TTL and may be seconds from its cap; inheriting that would have
  // the reaper close the browser under a run that had only just picked it up,
  // and every verb would start answering "session expired" mid-task.
  const settings = cloudBrowserSettings()
  const claimed = await deps.prisma.cloudBrowserSession.updateMany({
    where: {
      id: candidate.id,
      runId: null,
      status: 'active',
      controlledByUserId: null,
      // Never adopt a row the reaper has simply not reached yet.
      expiresAt: { gt: new Date() },
    },
    data: {
      runId: input.runId,
      expiresAt: new Date(Date.now() + settings.ttlMs),
    },
  })
  if (claimed.count === 0) return null
  const capability = await loadSessionCapability(deps.prisma, {
    encryptionSecret: input.encryptionSecret,
    sessionId: candidate.id,
  })
  if (!capability) {
    // Adopted but undrivable — hand it straight back rather than holding a
    // session this run cannot reach.
    await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: candidate.id, runId: input.runId },
      data: { runId: null },
    })
    return null
  }
  return { connectUrl: capability.connectUrl, sessionId: candidate.id }
}

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
  agentBrowser: { principalUserId: string | null; _count: { logins: number } } | null
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
      agentBrowser: { select: { principalUserId: true, _count: { select: { logins: true } } } },
    },
  })


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

export {
  BLOCKING_SESSION_STATUSES,
  LIVE_SESSION_STATUSES,
  CLOUD_BROWSER_SETTING_KEY,
  cloudBrowserSettings,
  markConnectionNeedsAttention,
  resolveConnectionForRun,
  type CloudBrowserDeps,
  type ResolvedConnection,
} from './session-foundation.js'

export {
  reapExpiredCloudBrowserSessions,
  releaseCloudBrowserSession,
  releaseSessionsForRun,
} from './session-release.js'

export {
  claimSessionControl,
  CONTROL_CLAIM_TTL_MS,
  expireStaleControlClaims,
  hasActiveSessionControlClaim,
  releaseSessionControl,
  userMayClaimCloudBrowserSessionControl,
  withCloudBrowserSessionControlLock,
} from './session-control.js'
