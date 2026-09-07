import {
  hasActiveSessionControlClaim,
  isPrivateBrowserHome,
  loadAgentBrowserLoginStatus,
  userMayClaimCloudBrowserSessionControl,
  viewerMaySeeAgentBrowser,
} from '@nessie/browser-cloud'
import { browserViewportOrDefault, type BrowserViewport } from '@nessie/schemas'
import { BROWSER_OPEN_TOOL_ID, isExplicitToolGranted } from '@nessie/runtime'
import { isAgentAccessibleToActor } from '@nessie/team-admin'
import { z } from 'zod'

import { findThreadForUser } from '../services/message-read-state.js'
import type { RouteDeps } from './types.js'

/**
 * Cloud-browser audience and control authority.
 *
 * The browser route deliberately calls these helpers for every read and human
 * action. A thread membership is only the first gate: a browser that a person
 * requested or is currently controlling is their private surface even when the
 * thread itself is shared.
 */
export const browserScopeFor = async (
  prisma: RouteDeps['prisma'],
  input: { organizationId: string; agentId: string; viewerId: string },
): Promise<{ principalUserId: string | null } | null> => {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: { ownerUserId: true, systemManaged: true, visibility: true },
  })
  if (!agent) return null
  if (agent.visibility === 'private') {
    if (agent.ownerUserId !== input.viewerId) return null
    return { principalUserId: agent.ownerUserId }
  }
  return { principalUserId: agent.systemManaged ? input.viewerId : null }
}

export const browserSessionIsShared = (input: {
  principalUserId?: string | null
  agentVisibility: string
}): boolean => input.principalUserId === null && input.agentVisibility !== 'private'

/** The site a URL is on, for a reader who may know where but not what. */
export const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export const agentHasBrowserOpenGrant = async (
  prisma: RouteDeps['prisma'],
  input: { agentId: string; organizationId: string },
): Promise<boolean> => {
  const agent = await prisma.agent.findFirst({
    select: { toolPolicy: true },
    where: { id: input.agentId, organizationId: input.organizationId },
  })
  return isExplicitToolGranted(agent?.toolPolicy, BROWSER_OPEN_TOOL_ID)
}

/**
 * Decides the audience before a session detail, screenshot, or human action.
 *
 * A person-requested session is private from its first allocation. This closes
 * the former handover window where a team member could watch a login page
 * before Done. An active control lease is also private to its holder. Only an
 * unattended, unsigned agent run is observable by other thread members.
 */
export const viewerMaySeeCloudBrowserSession = (input: {
  agentBrowserId: string | null
  agentBrowserPrincipalUserId?: string | null
  authenticated: boolean
  controlClaimedAt: Date | null
  controlledByUserId: string | null
  durableBrowserAllowed: boolean
  requestedByUserId: string | null
  runId: string | null
  viewerId: string
  personalAccessGrant?: { expiresAt: Date; status: string; userId: string } | null
  now?: Date
}): boolean => {
  const personalGrant = input.personalAccessGrant
  if (personalGrant) {
    return personalGrant.status === 'active'
      && personalGrant.expiresAt > (input.now ?? new Date())
      && personalGrant.userId === input.viewerId
  }
  const claimIsActive = hasActiveSessionControlClaim(input, input.now)
  if (claimIsActive) return input.controlledByUserId === input.viewerId
  if (input.runId === null) {
    return input.requestedByUserId === input.viewerId
  }
  if (!input.authenticated && input.agentBrowserPrincipalUserId !== null
    && input.agentBrowserPrincipalUserId !== undefined) {
    return input.agentBrowserPrincipalUserId === input.viewerId
  }
  if (!input.authenticated) return true
  return input.agentBrowserId !== null && input.durableBrowserAllowed
}

export type BrowserSessionViewerMode = 'controller' | 'observer'

export interface ViewableCloudBrowserSession {
  id: string
  threadId: string
  agentId: string
  agentName: string
  requestedByUserId: string | null
  runId: string | null
  status: string
  interactionTransport: 'legacy' | 'mediated'
  /** A task-scoped grant has its own fixed expiry and cannot be extended. */
  personalAccess: boolean
  personalAccessGrantId: string | null
  startedAt: Date
  endedAt: Date | null
  controlledByUserId: string | null
  controlClaimedAt: Date | null
  controlLeaseActive: boolean
  browserbaseSessionId: string | null
  expiresAt: Date
  agentBrowserId: string | null
  connectionProjectId: string | null
  connectionApiKeyRef: string
  shared: boolean
  viewport: BrowserViewport
  /** Human input is private-home only; team viewers are always observers. */
  canControl: boolean
  viewerMode: BrowserSessionViewerMode
}

export const loadViewableSession = async (
  prisma: RouteDeps['prisma'],
  input: {
    actorContext: Parameters<RouteDeps['isAgentAccessibleToActor']>[0]
    sessionId: string
  },
): Promise<ViewableCloudBrowserSession | null> => {
  const session = await prisma.cloudBrowserSession.findFirst({
    where: { id: input.sessionId, organizationId: input.actorContext.tenant.organizationId },
    select: {
      id: true,
      threadId: true,
      agentBrowserId: true,
      authenticated: true,
      requestedByUserId: true,
      agentId: true,
      runId: true,
      status: true,
      interactionTransport: true,
      startedAt: true,
      endedAt: true,
      controlledByUserId: true,
      controlClaimedAt: true,
      browserbaseSessionId: true,
      viewportHeight: true,
      viewportWidth: true,
      expiresAt: true,
      agent: { select: { name: true, systemManaged: true, visibility: true } },
      agentBrowser: {
        select: { principalUserId: true, viewportHeight: true, viewportWidth: true },
      },
      connection: { select: { projectId: true, apiKeyRef: true } },
      personalAccessGrant: {
        select: { agentId: true, expiresAt: true, id: true, status: true, threadId: true, userId: true },
      },
    },
  })
  if (!session || session.expiresAt <= new Date()) return null
  // A Browserbase URL minted before the mediated transport cutover cannot be
  // revoked individually. Keep that legacy session off every Nessie surface;
  // the lifecycle reaper owns stopping its remote browser.
  if (session.interactionTransport !== 'mediated') return null
  if (session.agentBrowserId) {
    const loginStatus = await loadAgentBrowserLoginStatus(prisma, session.agentBrowserId)
    if (!loginStatus?.permitsSensitiveUse) return null
  }
  const viewerId = input.actorContext.actor.actorId
  const thread = await findThreadForUser(
    prisma,
    session.threadId,
    viewerId,
    input.actorContext.tenant.organizationId,
  )
  if (!thread) return null
  if (session.personalAccessGrant) {
    const grant = session.personalAccessGrant
    if (grant.agentId !== session.agentId || grant.threadId !== session.threadId
      || grant.status !== 'active' || grant.expiresAt <= new Date() || grant.userId !== viewerId
      || !(await isPrivateBrowserHome(prisma, {
        agentId: session.agentId,
        organizationId: input.actorContext.tenant.organizationId,
        threadId: session.threadId,
        userId: viewerId,
      }))) return null
  }
  if (!session.agent.systemManaged && !(await isAgentAccessibleToActor(
    prisma,
    input.actorContext,
    session.agentId,
  ))) return null
  if (!(await agentInThread(prisma, {
    organizationId: input.actorContext.tenant.organizationId,
    threadId: session.threadId,
    agentId: session.agentId,
    userId: viewerId,
  }))) return null
  const durableBrowserAllowed = session.agentBrowserId && session.authenticated
    ? await viewerMaySeeAgentBrowser(prisma, {
      agentBrowserId: session.agentBrowserId,
      viewerId,
    })
    : false
  if (!viewerMaySeeCloudBrowserSession({
    agentBrowserId: session.agentBrowserId,
    agentBrowserPrincipalUserId: session.agentBrowser?.principalUserId,
    authenticated: session.authenticated,
    controlClaimedAt: session.controlClaimedAt,
    controlledByUserId: session.controlledByUserId,
    durableBrowserAllowed,
    requestedByUserId: session.requestedByUserId,
    runId: session.runId,
    viewerId,
    personalAccessGrant: session.personalAccessGrant,
  })) return null

  const controlLeaseActive = hasActiveSessionControlClaim(session)
  const isController = controlLeaseActive
    && session.controlledByUserId === viewerId
  const canControl = await userMayClaimCloudBrowserSessionControl(prisma, {
    sessionId: session.id,
    userId: viewerId,
  })
  return {
    id: session.id,
    threadId: session.threadId,
    agentId: session.agentId,
    agentName: session.agent.name,
    requestedByUserId: session.requestedByUserId,
    runId: session.runId,
    status: session.status,
    interactionTransport: session.interactionTransport,
    personalAccess: session.personalAccessGrant !== null,
    personalAccessGrantId: session.personalAccessGrant?.id ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    controlledByUserId: session.controlledByUserId,
    controlClaimedAt: session.controlClaimedAt,
    controlLeaseActive,
    browserbaseSessionId: session.browserbaseSessionId,
    expiresAt: session.expiresAt,
    connectionProjectId: session.connection.projectId,
    agentBrowserId: session.agentBrowserId,
    connectionApiKeyRef: session.connection.apiKeyRef,
    shared: browserSessionIsShared({
      agentVisibility: session.agent.visibility,
      principalUserId: session.agentBrowser?.principalUserId,
    }),
    viewport: browserViewportOrDefault({
      height: session.viewportHeight ?? session.agentBrowser?.viewportHeight ?? null,
      width: session.viewportWidth ?? session.agentBrowser?.viewportWidth ?? null,
    }),
    canControl,
    viewerMode: isController ? 'controller' : 'observer',
  }
}

export const agentInThread = async (
  prisma: RouteDeps['prisma'],
  input: { organizationId: string; threadId: string; agentId: string; userId: string },
): Promise<{ channelId: string; teamId: string | null } | null> => {
  if (!z.string().uuid().safeParse(input.threadId).success
    || !z.string().uuid().safeParse(input.agentId).success) return null
  const thread = await findThreadForUser(prisma, input.threadId, input.userId, input.organizationId)
  if (!thread) return null
  const bound = await prisma.agentBinding.count({
    where: {
      agentId: input.agentId,
      channelId: thread.channel.id,
      OR: [{ principalUserId: null }, { principalUserId: input.userId }],
    },
  })
  if (bound === 0) return null
  const channel = await prisma.channel.findUnique({
    where: { id: thread.channel.id },
    select: { teamId: true },
  })
  return { channelId: thread.channel.id, teamId: channel?.teamId ?? null }
}
