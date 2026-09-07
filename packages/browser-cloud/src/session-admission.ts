import { Prisma } from '@prisma/client'
import { DEFAULT_BROWSER_VIEWPORT, type BrowserViewport } from '@nessie/schemas'

import type { BrowserbaseClient, BrowserbaseSession } from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError, isCloudBrowserError } from './errors.js'
import { sealConnectCapability } from './session-capability.js'
import {
  BLOCKING_SESSION_STATUSES,
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

  let admission: { connection: ResolvedConnection; rowId: string }
  try {
    admission = await deps.prisma.$transaction(async (tx) => {
      // Disconnect and credential rotation take this same parent-row lock.
      // Once this returns, neither can remove or re-key the connection until
      // the allocating row is committed and therefore visible to their
      // blocking-session check.
      const locked = await tx.$queryRaw<Array<{
        apiKeyRef: string
        id: string
        projectId: string | null
        scope: ResolvedConnection['scope']
      }>>(Prisma.sql`SELECT id, scope, project_id AS "projectId", api_key_ref AS "apiKeyRef"
        FROM cloud_browser_connections
        WHERE id = ${connection.id}::uuid
          AND organization_id = ${input.organizationId}::uuid
          AND status = 'active'
        FOR UPDATE`)
      const activeConnection = locked[0]
      if (!activeConnection) {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
          'This Browserbase connection was disconnected. Reconnect it before opening a browser.',
        )
      }
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
        // Reset takes this exact row lock before it checks for sessions. The
        // parent lock fences connection changes; this child lock fences a
        // reset from tombstoning the context after this admission checked it.
        const browsers = await tx.$queryRaw<Array<{ connectionId: string; id: string }>>(
          Prisma.sql`SELECT id, connection_id AS "connectionId"
            FROM agent_browsers
            WHERE id = ${input.agentBrowser.id}::uuid
              AND status = 'active'
            FOR UPDATE`,
        )
        if (browsers[0]?.connectionId !== activeConnection.id) {
          throw new CloudBrowserError(
            CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
            'This agent’s browser was reset. Open it again to get a fresh one.',
          )
        }
      }
      const created = await tx.cloudBrowserSession.create({
        data: {
          organizationId: input.organizationId,
          connectionId: activeConnection.id,
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
      return {
        connection: activeConnection,
        rowId: created.id,
      }
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

  let client: BrowserbaseClient | null = null
  let remoteSession: BrowserbaseSession | null = null
  try {
    client = await loadClient(deps, admission.connection)
    remoteSession = await client.createSession({
      timeoutSeconds: Math.ceil(settings.ttlMs / 1000),
      keepAlive: input.runId === null,
      viewport: viewportForSession(input),
      ...(input.agentBrowser
        ? { contextId: input.agentBrowser.browserbaseContextId, persistContext: true }
        : {}),
    })
    if (input.agentBrowser) {
      await deps.prisma.agentBrowser
        .update({ where: { id: input.agentBrowser.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined)
    }
    const activated = await deps.prisma.cloudBrowserSession.updateMany({
      where: { id: admission.rowId, status: 'allocating' },
      data: {
        status: 'active',
        browserbaseSessionId: remoteSession.id,
        connectCapabilityCiphertext: sealConnectCapability(input.encryptionSecret, remoteSession.connectUrl),
        originGate: input.originGate,
      },
    })
    if (activated.count !== 1) {
      throw new Error('Cloud browser session was no longer allocating after Browserbase created it.')
    }
    return {
      sessionId: admission.rowId,
      browserbaseSessionId: remoteSession.id,
      connectUrl: remoteSession.connectUrl,
      expiresAt,
    }
  } catch (error) {
    if (remoteSession && client) {
      let stopped = false
      try {
        await client.endSession(remoteSession.id)
        stopped = true
      } catch {
        // A known remote session remains blocking until a reaper confirms it.
      }
      await deps.prisma.cloudBrowserSession.updateMany({
        where: { id: admission.rowId },
        data: stopped
          ? {
            browserbaseSessionId: remoteSession.id,
            endedAt: new Date(),
            releasedBy: 'open_persist_failed',
            status: 'released',
          }
          : {
            browserbaseSessionId: remoteSession.id,
            lastError: (error as Error).message.slice(0, 500),
            releasedBy: 'open_persist_failed',
            status: 'unknown',
          },
      }).catch(() => undefined)
    } else {
      await deps.prisma.cloudBrowserSession.updateMany({
        where: { id: admission.rowId },
        data: {
          status: 'failed',
          endedAt: new Date(),
          releasedBy: 'open_failed',
          lastError: (error as Error).message.slice(0, 500),
        },
      })
    }
    if (isCloudBrowserError(error) && error.code === CLOUD_BROWSER_ERROR_CODES.AUTH_FAILED) {
      await markConnectionNeedsAttention(deps.prisma, {
        connectionId: admission.connection.id,
        reason: 'auth_failed',
        detail: error.message,
      })
    }
    throw error
  }
}
