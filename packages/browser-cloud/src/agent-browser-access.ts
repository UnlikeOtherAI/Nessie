import type { PrismaClient } from '@prisma/client'

import { BLOCKING_SESSION_STATUSES } from './session-foundation.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'

/**
 * A team browser with a human login has no durable proof that the signer
 * authorized every team member or every later agent run. Keep it quarantined
 * until a separately authorized team-service credential model exists.
 */
export type AgentBrowserLoginStatus = {
  kind: 'legacy_team_human' | 'personal' | 'unsigned'
  permitsSensitiveUse: boolean
}

export const agentBrowserLoginStatus = (input: {
  loginCount: number
  principalUserId: string | null
}): AgentBrowserLoginStatus => {
  if (input.loginCount === 0) return { kind: 'unsigned', permitsSensitiveUse: true }
  if (input.principalUserId === null) return { kind: 'legacy_team_human', permitsSensitiveUse: false }
  return { kind: 'personal', permitsSensitiveUse: true }
}

type BrowserAccessDatabase = Pick<PrismaClient, 'agentBrowser' | 'agentBrowserLogin'>

export const loadAgentBrowserLoginStatus = async (
  prisma: BrowserAccessDatabase,
  agentBrowserId: string,
): Promise<AgentBrowserLoginStatus | null> => {
  const browser = await prisma.agentBrowser.findUnique({
    where: { id: agentBrowserId },
    select: { principalUserId: true, _count: { select: { logins: true } } },
  })
  return browser && agentBrowserLoginStatus({
    loginCount: browser._count.logins,
    principalUserId: browser.principalUserId,
  })
}

/** A human sign-in may only enter a per-person browser, never a team jar. */
export const recordAgentBrowserLogin = async (
  prisma: BrowserAccessDatabase,
  input: {
    agentBrowserId: string
    organizationId: string
    serviceHint: string
    userId: string
  },
): Promise<void> => {
  const browser = await prisma.agentBrowser.findFirst({
    where: { id: input.agentBrowserId, organizationId: input.organizationId, status: 'active' },
    select: { principalUserId: true },
  })
  if (!browser) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_SESSION, 'This browser is no longer available.')
  }
  if (browser.principalUserId === null) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_SESSION,
      'People can sign in only to a private agent or personal assistant browser.',
    )
  }
  if (browser.principalUserId !== input.userId) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_SESSION, 'This private browser belongs to someone else.')
  }
  await prisma.agentBrowserLogin.create({
    data: {
      organizationId: input.organizationId,
      agentBrowserId: input.agentBrowserId,
      userId: input.userId,
      serviceHint: input.serviceHint.slice(0, 200),
    },
  })
}

/**
 * The viewer boundary for tabs, screenshots, live views, and resumes. A
 * quarantined legacy team jar exposes no page material, including to its
 * signer; reset remains a separate signer/owner recovery action.
 */
export const viewerMaySeeAgentBrowser = async (
  prisma: BrowserAccessDatabase,
  input: { agentBrowserId: string; viewerId: string },
): Promise<boolean> => {
  const browser = await prisma.agentBrowser.findUnique({
    where: { id: input.agentBrowserId },
    select: { principalUserId: true, logins: { select: { userId: true } } },
  })
  if (!browser) return false
  const status = agentBrowserLoginStatus({
    loginCount: browser.logins.length,
    principalUserId: browser.principalUserId,
  })
  if (!status.permitsSensitiveUse) return false
  if (status.kind === 'unsigned') return true
  return browser.principalUserId === input.viewerId
    && browser.logins.some((login) => login.userId === input.viewerId)
}

/** Facts for the structural prompt block; quarantined services are never named. */
export const describeAgentBrowser = async (
  prisma: Pick<PrismaClient, 'agentBrowser' | 'cloudBrowserSession'>,
  input: { organizationId: string; agentId: string; principalUserId?: string | null },
): Promise<{ exists: boolean; inUse: boolean; loginStatus: AgentBrowserLoginStatus['kind']; services: string[] }> => {
  const browser = await prisma.agentBrowser.findFirst({
    where: {
      organizationId: input.organizationId,
      agentId: input.agentId,
      status: 'active',
      ...(input.principalUserId === undefined ? {} : { principalUserId: input.principalUserId }),
    },
    select: { id: true, principalUserId: true, logins: { select: { serviceHint: true }, take: 20 } },
  })
  if (!browser) return { exists: false, inUse: false, loginStatus: 'unsigned', services: [] }
  const live = await prisma.cloudBrowserSession.count({
    where: { agentBrowserId: browser.id, status: { in: [...BLOCKING_SESSION_STATUSES] } },
  })
  const status = agentBrowserLoginStatus({
    loginCount: browser.logins.length,
    principalUserId: browser.principalUserId,
  })
  return {
    exists: true,
    inUse: live > 0,
    loginStatus: status.kind,
    services: status.permitsSensitiveUse ? [...new Set(browser.logins.map((row) => row.serviceHint))] : [],
  }
}
