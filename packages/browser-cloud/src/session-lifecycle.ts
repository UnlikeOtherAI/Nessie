import type { PrismaClient } from '@prisma/client'

import { loadSessionCapability } from './session-capability.js'
import {
  cloudBrowserSettings,
  LIVE_SESSION_STATUSES,
  type CloudBrowserDeps,
} from './session-foundation.js'


export { openCloudBrowserSession, type OpenSessionInput, type OpenSessionResult } from './session-admission.js'

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
  input: { agentBrowserId: string; runId: string; encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput },
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
