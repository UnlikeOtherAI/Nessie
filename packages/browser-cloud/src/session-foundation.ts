import type { PrismaClient } from '@prisma/client'
import { resolveScopedSetting } from '@nessie/runtime'
import type { ConnectionScope } from './connection-management.js'

import {
  createBrowserbaseClient,
  type BrowserbaseClient,
  type BrowserbaseCredentials,
} from './browserbase-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'
import type { CdpClient } from './cdp-client.js'

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
/**
 * States that may still own a remote browser. `unknown` is deliberately not
 * drivable, but it blocks reuse, reset, disconnect and capacity admission
 * until Browserbase confirms the stop.
 */
export const BLOCKING_SESSION_STATUSES = [...LIVE_SESSION_STATUSES, 'unknown'] as const

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

export const loadClient = async (
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
