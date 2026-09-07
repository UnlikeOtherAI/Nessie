import type { Prisma, PrismaClient } from '@prisma/client'
import {
  BROWSER_ACT_TOOL_ID,
  BROWSER_DOWNLOAD_TOOL_ID,
  BROWSER_OBSERVE_TOOL_ID,
  BROWSER_OPEN_TOOL_ID,
  isExplicitToolGranted,
  TERMINAL_RUN_STATUSES,
} from '@nessie/runtime'
import type { BrowserViewport } from '@nessie/schemas'

import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'
import { isPrivateBrowserHome } from './private-browser-home.js'
import {
  cloudBrowserSettings,
  openCloudBrowserSession,
  releaseCloudBrowserSession,
  type CloudBrowserDeps,
  type ResolvedConnection,
} from './session-lifecycle.js'

export const PERSONAL_BROWSER_ACCESS_MAX_MS = 15 * 60 * 1000
const PERSONAL_BROWSER_TOOL_IDS = [
  BROWSER_OPEN_TOOL_ID,
  BROWSER_OBSERVE_TOOL_ID,
  BROWSER_ACT_TOOL_ID,
  BROWSER_DOWNLOAD_TOOL_ID,
]

export const normalizePersonalBrowserOrigins = (origins: readonly string[]): string[] => {
  const normalized = origins.map((origin) => {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.port) {
      throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED, 'Browser access requires exact HTTPS origins.')
    }
    return url.origin
  })
  if (normalized.length === 0 || normalized.length > 20 || new Set(normalized).size !== normalized.length) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED, 'Choose between one and twenty distinct HTTPS origins.')
  }
  return normalized
}

export const personalBrowserGrantAllowsOrigin = (origins: readonly string[], url: string): boolean => {
  try {
    return origins.includes(new URL(url).origin)
  } catch {
    return false
  }
}

export const createPersonalBrowserAccessGrant = async (
  prisma: Pick<PrismaClient, 'browserPersonalAccessGrant'>,
  input: {
    agentId: string
    expiresAt: Date
    organizationId: string
    origins: readonly string[]
    runId: string
    threadId: string
    userId: string
  },
): Promise<{ expiresAt: Date; grantId: string; origins: string[] }> => {
  const now = new Date()
  const ceiling = new Date(now.getTime() + Math.min(
    PERSONAL_BROWSER_ACCESS_MAX_MS,
    cloudBrowserSettings().ttlMs,
  ))
  const expiresAt = input.expiresAt < ceiling ? input.expiresAt : ceiling
  if (expiresAt <= now) throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.EXPIRED, 'Browser access has expired.')
  const origins = normalizePersonalBrowserOrigins(input.origins)
  const grant = await prisma.browserPersonalAccessGrant.create({
    data: { ...input, expiresAt, origins },
    select: { id: true },
  })
  return { expiresAt, grantId: grant.id, origins }
}

export type PersonalBrowser = {
  browserbaseContextId: string
  connection: ResolvedConnection
  id: string
  principalUserId: string | null
  viewport: BrowserViewport
}

type LoadedGrant = {
  agent: { ownerUserId: string | null; systemManaged: boolean; toolPolicy: unknown; visibility: 'private' | 'team' }
  agentId: string
  expiresAt: Date
  id: string
  organizationId: string
  origins: string[]
  run: { status: 'pending' | 'running' | 'waiting_approval' | 'waiting_input' | 'completed' | 'failed' | 'cancelled' }
  runId: string
  sessionId: string | null
  status: 'pending' | 'active' | 'revoked' | 'expired'
  thread: {
    channelId: string
    channel: { id: string; systemChannelType: string | null; type: 'dm' | 'standard'; _count: { members: number } }
  }
  threadId: string
  userId: string
}

type GrantDatabase = Pick<PrismaClient, 'agent' | 'agentBinding' | 'browserPersonalAccessGrant' | 'channelMember' | 'cloudBrowserSession' | 'organizationMember' | 'run' | 'thread'>

const grantRunIsTerminal = (status: LoadedGrant['run']['status']): boolean =>
  TERMINAL_RUN_STATUSES.includes(status)

const loadGrant = async (prisma: GrantDatabase, where: Record<string, unknown>): Promise<LoadedGrant | null> =>
  prisma.browserPersonalAccessGrant.findFirst({
    where,
    select: {
      agent: { select: { ownerUserId: true, systemManaged: true, toolPolicy: true, visibility: true } },
      agentId: true,
      expiresAt: true,
      id: true,
      organizationId: true,
      origins: true,
      run: { select: { status: true } },
      runId: true,
      sessionId: true,
      status: true,
      thread: {
        select: {
          channelId: true,
          channel: {
            select: {
              id: true,
              systemChannelType: true,
              type: true,
              _count: { select: { members: true } },
            },
          },
        },
      },
      threadId: true,
      userId: true,
    },
  })

const assertPrivateHome = async (prisma: GrantDatabase, grant: LoadedGrant): Promise<void> => {
  if (!(await isPrivateBrowserHome(prisma, {
    agentId: grant.agentId,
    organizationId: grant.organizationId,
    threadId: grant.threadId,
    userId: grant.userId,
  }))) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION,
      'Personal browser access is available only in your private agent home.',
    )
  }
}

const assertGrantedTools = (policy: unknown, toolId?: string): void => {
  const ids = toolId ? [BROWSER_OPEN_TOOL_ID, toolId] : PERSONAL_BROWSER_TOOL_IDS
  if (!ids.every((id) => isExplicitToolGranted(policy, id))) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION, 'Browser access is no longer enabled for this agent.')
  }
}

const loadPersonalConnection = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<ResolvedConnection> => {
  const connection = await prisma.cloudBrowserConnection.findFirst({
    where: { organizationId: input.organizationId, scope: 'user', status: 'active', userId: input.userId },
    select: { apiKeyRef: true, id: true, projectId: true, scope: true },
  })
  if (!connection) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION, 'Connect a personal Browserbase account first.')
  }
  return connection
}

/** Opens a fresh no-context session, even when the account has no durable jar. */
export const activatePersonalBrowserAccessGrant = async (
  deps: CloudBrowserDeps,
  input: { grantId: string; userId: string; viewport?: BrowserViewport },
): Promise<{ expiresAt: Date; grantId: string; initialOrigin: string; sessionId: string }> => {
  const grant = await loadGrant(deps.prisma, {
    id: input.grantId,
    status: { in: ['pending', 'active'] },
    userId: input.userId,
    expiresAt: { gt: new Date() },
  })
  if (!grant) throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.EXPIRED, 'This private browser grant is no longer available.')
  if (grantRunIsTerminal(grant.run.status) || grant.run.status !== 'waiting_input') {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.EXPIRED, 'This private browser grant is no longer available.')
  }
  await assertPrivateHome(deps.prisma, grant)
  assertGrantedTools(grant.agent.toolPolicy, BROWSER_OPEN_TOOL_ID)
  if (grant.status === 'active') {
    const session = grant.sessionId
      ? await deps.prisma.cloudBrowserSession.findFirst({
        where: {
          agentBrowserId: null,
          agentId: grant.agentId,
          expiresAt: { gt: new Date() },
          id: grant.sessionId,
          interactionTransport: 'mediated',
          organizationId: grant.organizationId,
          requestedByUserId: grant.userId,
          runId: null,
          status: 'active',
          threadId: grant.threadId,
        },
        select: { id: true },
      })
      : null
    if (!session) {
      throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.EXPIRED, 'This private browser grant is no longer available.')
    }
    return {
      expiresAt: grant.expiresAt,
      grantId: grant.id,
      initialOrigin: grant.origins[0]!,
      sessionId: session.id,
    }
  }
  const connection = await loadPersonalConnection(deps.prisma, grant)
  const opened = await openCloudBrowserSession(deps, {
    connectionOverride: connection,
    encryptionSecret: deps.encryptionSecret ?? '',
    expiresAt: grant.expiresAt,
    originGate: { authenticatedOrigins: [], currentUrl: grant.origins[0] ?? null, touchedAuthenticated: false },
    organizationId: grant.organizationId,
    requestedByUserId: grant.userId,
    runId: null,
    teamId: null,
    threadId: grant.threadId,
    agentId: grant.agentId,
    ...(input.viewport ? { viewport: input.viewport } : {}),
  })
  const linked = await deps.prisma.browserPersonalAccessGrant.updateMany({
    where: {
      id: grant.id,
      status: 'pending',
      expiresAt: { gt: new Date() },
      run: { status: { notIn: [...TERMINAL_RUN_STATUSES] } },
    },
    data: { activatedAt: new Date(), sessionId: opened.sessionId, status: 'active' },
  })
  if (linked.count !== 1) {
    await releaseCloudBrowserSession(deps, { releasedBy: 'personal_grant_lost', sessionId: opened.sessionId })
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.EXPIRED, 'This private browser grant is no longer available.')
  }
  return {
    expiresAt: grant.expiresAt,
    grantId: grant.id,
    initialOrigin: grant.origins[0]!,
    sessionId: opened.sessionId,
  }
}

/** Claims the already human-controlled no-context session for its exact run. */
export const adoptPersonalBrowserAccessGrant = async (
  tx: Prisma.TransactionClient,
  input: {
    expectedOriginalRunId: string
    grantId: string
    runId: string
    threadId: string
    userId: string
  },
): Promise<{ sessionId: string } | null> => {
  const grant = await loadGrant(tx, {
    id: input.grantId,
    runId: input.expectedOriginalRunId,
    status: 'active',
    threadId: input.threadId,
    userId: input.userId, expiresAt: { gt: new Date() },
  })
  if (!grant) return null
  const successor = await tx.run.findFirst({
    where: {
      agentId: grant.agentId,
      continuationOfRunId: input.expectedOriginalRunId,
      id: input.runId,
      status: { notIn: [...TERMINAL_RUN_STATUSES] },
      threadId: grant.threadId,
    },
    select: { id: true },
  })
  if (!successor) return null
  await assertPrivateHome(tx, grant)
  assertGrantedTools(grant.agent.toolPolicy, BROWSER_OPEN_TOOL_ID)
  if (!grant.sessionId) return null
  const adopted = await tx.cloudBrowserSession.updateMany({
    where: { id: grant.sessionId, runId: null, status: 'active', expiresAt: { gt: new Date() } },
    data: { runId: input.runId },
  })
  if (adopted.count !== 1) return null
  const moved = await tx.browserPersonalAccessGrant.updateMany({
    where: { id: grant.id, runId: input.expectedOriginalRunId, status: 'active' },
    data: { runId: input.runId },
  })
  return moved.count === 1 ? { sessionId: grant.sessionId } : null
}

/** Revoke locally first; provider closure follows without making the grant usable again. */
export const revokePersonalBrowserAccessGrant = async (
  deps: CloudBrowserDeps,
  input: { grantId: string; releasedBy: string },
): Promise<boolean> => {
  const grant = await deps.prisma.browserPersonalAccessGrant.findUnique({
    where: { id: input.grantId }, select: { expiresAt: true, sessionId: true, status: true },
  })
  if (!grant) return false
  const status = grant.expiresAt <= new Date() ? 'expired' : 'revoked'
  const changed = await deps.prisma.browserPersonalAccessGrant.updateMany({
    where: { id: input.grantId, status: { in: ['pending', 'active'] } }, data: { revokedAt: new Date(), status },
  })
  if (changed.count === 1 && grant.sessionId) {
    await releaseCloudBrowserSession(deps, { releasedBy: input.releasedBy, sessionId: grant.sessionId })
  }
  return changed.count === 1
}

/** Terminal writers use this to prevent any grant from outliving its exact run. */
export const revokePersonalBrowserAccessForRun = async (
  deps: CloudBrowserDeps,
  input: { releasedBy: string; runId: string },
): Promise<void> => {
  const grants = await deps.prisma.browserPersonalAccessGrant.findMany({
    where: { runId: input.runId, status: { in: ['pending', 'active'] } }, select: { id: true },
  })
  await Promise.all(grants.map((grant) => revokePersonalBrowserAccessGrant(deps, { ...input, grantId: grant.id })))
}

/** Import-only session seam. Callers must record selected-origin provenance before use. */
export const openPersonalBrowserAccessSession = async (
  deps: CloudBrowserDeps,
  input: {
    agentBrowser: PersonalBrowser
    agentId: string
    expiresAt: Date
    organizationId: string
    threadId: string
    userId: string
  },
): Promise<{ agentBrowserId: string; connectUrl: string; expiresAt: Date; sessionId: string }> => {
  if (input.agentBrowser.principalUserId !== input.userId) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_CONNECTION, 'This private browser belongs to another person.')
  }
  const opened = await openCloudBrowserSession(deps, {
    agentBrowser: {
      browserbaseContextId: input.agentBrowser.browserbaseContextId,
      connectionId: input.agentBrowser.connection.id,
      hasLogins: true,
      id: input.agentBrowser.id,
      viewport: input.agentBrowser.viewport,
    },
    encryptionSecret: deps.encryptionSecret ?? '',
    expiresAt: input.expiresAt,
    originGate: { authenticatedOrigins: [], currentUrl: null, touchedAuthenticated: false },
    organizationId: input.organizationId,
    requestedByUserId: input.userId,
    runId: null,
    teamId: null,
    threadId: input.threadId,
    agentId: input.agentId,
  })
  return { agentBrowserId: input.agentBrowser.id, ...opened }
}

export const validatePersonalBrowserAccess = async (
  prisma: PrismaClient,
  input: { agentId: string; runId: string; sessionId: string; threadId: string; toolId: string },
): Promise<{ origins: string[]; userId: string } | null> => {
  const grant = await loadGrant(prisma, { sessionId: input.sessionId })
  if (!grant) return null
  if (grant.expiresAt <= new Date()) {
    await prisma.browserPersonalAccessGrant.updateMany({
      where: { id: grant.id, status: 'active' },
      data: { status: 'expired', revokedAt: new Date() },
    })
  }
  if (
    grant.expiresAt <= new Date()
    || grant.agentId !== input.agentId
    || grant.runId !== input.runId
    || grant.threadId !== input.threadId
  ) {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_SESSION, 'The private browser grant is no longer valid.')
  }
  await assertPrivateHome(prisma, grant)
  const current = await prisma.browserPersonalAccessGrant.findUnique({
    where: { id: grant.id },
    select: { status: true },
  })
  if (current?.status !== 'active') {
    throw new CloudBrowserError(CLOUD_BROWSER_ERROR_CODES.NO_SESSION, 'The private browser grant is no longer valid.')
  }
  assertGrantedTools(grant.agent.toolPolicy, input.toolId)
  return { origins: normalizePersonalBrowserOrigins(grant.origins), userId: grant.userId }
}

/**
 * Server-authored continuation facts for the one temporary browser capability
 * that is already attached to this exact run. The tool boundary still
 * revalidates the owner, home, tool grant, expiry, and session before every
 * browser operation; this prevents a resumed model from requesting the same
 * login merely because its card response says only "Done".
 */
export const loadActivePersonalBrowserAccessForRun = async (
  prisma: Pick<PrismaClient, 'browserPersonalAccessGrant'>,
  input: { agentId: string; runId: string; threadId: string },
): Promise<{ expiresAt: Date; grantId: string; origins: string[] } | null> =>
  prisma.browserPersonalAccessGrant.findFirst({
    select: { expiresAt: true, id: true, origins: true },
    where: {
      agentId: input.agentId,
      expiresAt: { gt: new Date() },
      runId: input.runId,
      sessionId: { not: null },
      status: 'active',
      threadId: input.threadId,
    },
  }).then((grant) => grant
    ? { expiresAt: grant.expiresAt, grantId: grant.id, origins: grant.origins }
    : null)

/** Once requested, no status (including revoked/expired) may fall back to a durable jar. */
export const hasPendingPersonalBrowserAccess = async (
  prisma: Pick<PrismaClient, 'browserPersonalAccessGrant'>,
  input: { agentId: string; runId: string; threadId: string },
): Promise<boolean> => {
  const { agentId, runId, threadId } = input
  return (await prisma.browserPersonalAccessGrant.count({
    where: { agentId, runId, threadId },
  })) > 0
}
