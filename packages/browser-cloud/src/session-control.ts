import { Prisma, type PrismaClient } from '@prisma/client'

import { recordAgentBrowserLogin } from './agent-browser-access.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'
import { isPrivateBrowserHome, type PrivateBrowserHomeDatabase } from './private-browser-home.js'

/** The viewer heartbeat window. */
export const CONTROL_CLAIM_TTL_MS = 90_000

/** Whether a control claimant may still receive a human-driving capability. */
export const hasActiveSessionControlClaim = (
  input: { controlledByUserId: string | null; controlClaimedAt: Date | null },
  now: Date = new Date(),
): boolean =>
  input.controlledByUserId !== null
  && input.controlClaimedAt !== null
  && input.controlClaimedAt.getTime() > now.getTime() - CONTROL_CLAIM_TTL_MS

type ControlAuthorityDatabase = Pick<PrismaClient, 'cloudBrowserSession'>
  & PrivateBrowserHomeDatabase

/**
 * Human control is a personal sign-in boundary, never a team-browser action.
 * Public team sessions can remain observable, but only a canonical private
 * home can receive keyboard or pointer input that might create a login.
 */
export const userMayClaimCloudBrowserSessionControl = async (
  prisma: ControlAuthorityDatabase | Prisma.TransactionClient,
  input: { sessionId: string; userId: string },
): Promise<boolean> => {
  const session = await prisma.cloudBrowserSession.findUnique({
    where: { id: input.sessionId },
    select: { agentId: true, organizationId: true, threadId: true },
  })
  return session !== null && isPrivateBrowserHome(prisma, {
    agentId: session.agentId,
    organizationId: session.organizationId,
    threadId: session.threadId,
    userId: input.userId,
  })
}

/**
 * Serializes a single human or worker CDP operation with a control transfer.
 * The caller must acquire CDP before this bounded transaction; provider dials
 * never hold the row lock. The callback rechecks its own authority while the
 * actual CloudBrowserSession row is locked.
 */
export const withCloudBrowserSessionControlLock = async <T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  input: { sessionId: string },
  drive: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '10s'`)
    const rows: Array<{ id: string }> = await tx.$queryRaw(Prisma.sql`
      SELECT id FROM cloud_browser_sessions WHERE id = ${input.sessionId}::uuid FOR UPDATE
    `)
    if (rows.length !== 1) {
      throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_SESSION, 'The browser session is no longer available.')
    }
    return drive(tx)
  }, { maxWait: 10_000, timeout: 10_000 })

/**
 * Take the controls. The locked row prevents a hand-back or a worker gesture
 * crossing this claim.
 */
export const claimSessionControl = async (
  prisma: PrismaClient,
  input: { sessionId: string; userId: string; now?: Date },
): Promise<boolean> => {
  const now = input.now ?? new Date()
  const staleBefore = new Date(now.getTime() - CONTROL_CLAIM_TTL_MS)
  return withCloudBrowserSessionControlLock(prisma, { sessionId: input.sessionId }, async (tx) => {
    if (!(await userMayClaimCloudBrowserSessionControl(tx, input))) return false
    const claimed = await tx.cloudBrowserSession.updateMany({
      where: {
        id: input.sessionId,
        status: 'active',
        expiresAt: { gt: now },
        OR: [
          { controlledByUserId: null },
          { controlledByUserId: input.userId },
          { controlClaimedAt: { lt: staleBefore } },
        ],
      },
      data: { authenticated: true, controlledByUserId: input.userId, controlClaimedAt: now },
    })
    if (claimed.count !== 1) return false
    const session = await tx.cloudBrowserSession.findUniqueOrThrow({
      where: { id: input.sessionId }, select: { agentBrowserId: true, organizationId: true },
    })
    if (session.agentBrowserId) {
      const existing = await tx.agentBrowserLogin.count({
        where: { agentBrowserId: session.agentBrowserId, userId: input.userId },
      })
      if (existing === 0) {
        await recordAgentBrowserLogin(tx, {
          agentBrowserId: session.agentBrowserId,
          organizationId: session.organizationId,
          serviceHint: 'May contain sign-ins entered while at the controls',
          userId: input.userId,
        })
      }
    }
    return true
  })
}

/** Only the holder may hand the browser back. */
type ControlReleaseDatabase = Pick<PrismaClient, 'cloudBrowserSession'> | PrismaClient

const releaseControl = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  input: { sessionId: string; userId: string },
): Promise<boolean> => {
  const released = await prisma.cloudBrowserSession.updateMany({
    where: { id: input.sessionId, controlledByUserId: input.userId },
    data: { authenticated: true, controlledByUserId: null, controlClaimedAt: null },
  })
  return released.count === 1
}

export const releaseSessionControl = async (
  prisma: ControlReleaseDatabase,
  input: { sessionId: string; userId: string },
): Promise<boolean> =>
  '$transaction' in prisma
    ? withCloudBrowserSessionControlLock(prisma, { sessionId: input.sessionId }, (tx) =>
      releaseControl(tx, input))
    : releaseControl(prisma, input)

/** Counts abandoned claims without clearing the worker-side hold. */
export const expireStaleControlClaims = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  now: Date = new Date(),
): Promise<number> =>
  prisma.cloudBrowserSession.count({
    where: {
      controlledByUserId: { not: null },
      controlClaimedAt: { lt: new Date(now.getTime() - CONTROL_CLAIM_TTL_MS) },
    },
  })
