import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CredentialStore } from '@nessie/dashboard'

import { agentBrowserLoginStatus, resetAgentBrowser } from '@nessie/browser-cloud'

import { AgentBrowserResponseSchema, BrowserLoginListSchema } from '../contracts/browser-cloud.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { agentHasBrowserOpenGrant, browserScopeFor } from './browser-cloud-access.js'
import type { RouteDeps } from './types.js'

type SendCloudBrowserError = (reply: FastifyReply, error: unknown) => boolean

export const registerBrowserCloudAgentRoutes = (
  app: FastifyInstance,
  input: {
    deps: RouteDeps & { dashboardCredentials: CredentialStore }
    sendCloudBrowserError: SendCloudBrowserError
  },
): void => {
  const { deps, sendCloudBrowserError } = input
  const { prisma, requireActorContext, requireUserActor } = deps

/**
 * An agent's browser: whether it exists, what it is signed in to, and who
 * signed it in. Readable by anyone entitled to see the agent, because that
 * audience is exactly who the logins are shared with.
 */
app.get('/api/agents/:agentId/browser', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply

  const { agentId } = request.params as { agentId: string }
  const organizationId = actorContext.tenant.organizationId
  const visible = await deps.isAgentAccessibleToActor(actorContext, agentId)
  if (!visible || !(await agentHasBrowserOpenGrant(prisma, { agentId, organizationId }))) {
    sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
    return reply
  }

  const browserScope = await browserScopeFor(prisma, {
    organizationId,
    agentId,
    viewerId: actorContext.actor.actorId,
  })
  const browser = browserScope && await prisma.agentBrowser.findFirst({
    where: { organizationId, agentId, status: 'active', ...browserScope },
    select: {
      id: true,
      principalUserId: true,
      createdAt: true,
      lastUsedAt: true,
      connection: { select: { scope: true, projectId: true } },
      logins: {
        select: {
          id: true,
          serviceHint: true,
          createdAt: true,
          userId: true,
          member: { select: { user: { select: { displayName: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  })
  if (!browser) {
    return createApiResponse(AgentBrowserResponseSchema.parse({ browser: null }))
  }
  const live = await prisma.cloudBrowserSession.count({
    where: {
      agentBrowserId: browser.id,
      status: { in: ['allocating', 'active', 'releasing'] },
    },
  })
  const loginStatus = agentBrowserLoginStatus({
    loginCount: browser.logins.length,
    principalUserId: browser.principalUserId,
  })

  return createApiResponse(AgentBrowserResponseSchema.parse({
    browser: {
      id: browser.id,
      connectionScope: browser.connection.scope,
      createdAt: browser.createdAt.toISOString(),
      lastUsedAt: browser.lastUsedAt?.toISOString() ?? null,
      inUse: live > 0,
      loginStatus: loginStatus.kind,
      // A quarantined team's prior sign-ins are not safe metadata. Only the
      // reset doorway remains available to its authorised steward or signer.
      logins: loginStatus.permitsSensitiveUse ? browser.logins.map((login) => ({
        id: login.id,
        serviceHint: login.serviceHint,
        createdAt: login.createdAt.toISOString(),
        signedInByUserId: login.userId,
        signedInByName: login.member?.user.displayName ?? null,
      })) : [],
    },
  }))
})

/**
 * Sign the agent out of everything and start its browser over.
 *
 * Open to the agent's steward, an owner, or anyone who signed this browser
 * in — their own revocation right. Deliberately not every member: wiping a
 * team's logins would otherwise be a one-click denial of service.
 */
app.post('/api/agents/:agentId/browser/reset', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply
  if (!requireUserActor(actorContext, reply)) return reply

  const { agentId } = request.params as { agentId: string }
  const organizationId = actorContext.tenant.organizationId
  const userId = actorContext.actor.actorId

  const resetScope = await browserScopeFor(prisma, {
    organizationId,
    agentId,
    viewerId: actorContext.actor.actorId,
  })
  const browser = resetScope && await prisma.agentBrowser.findFirst({
    where: { organizationId, agentId, status: 'active', ...resetScope },
    select: {
      id: true,
      agent: { select: { ownerUserId: true } },
      logins: { select: { userId: true } },
    },
  })
  if (!browser) {
    sendApiError(reply, 404, 'CLOUD_BROWSER_NO_BROWSER', 'This agent has no browser.')
    return reply
  }

  const isOwner = actorContext.actor.roles?.includes('owner') ?? false
  const isSteward = browser.agent.ownerUserId === userId
  const isSigner = browser.logins.some((login) => login.userId === userId)
  if (!isOwner && !isSteward && !isSigner) {
    sendApiError(
      reply,
      403,
      'FORBIDDEN',
      'Only this agent’s owner, a team owner, or somebody who signed it in can reset its browser.',
    )
    return reply
  }

  try {
    await resetAgentBrowser(prisma, { agentBrowserId: browser.id, organizationId })
    return reply.code(204).send()
  } catch (error) {
    if (sendCloudBrowserError(reply, error)) return reply
    throw error
  }
})

/**
 * Every sign-in this person performed, across agents — so revoking "I signed
 * that agent into my Google" never means hunting through agents.
 */
app.get('/api/browser-cloud/my-logins', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply

  const logins = await prisma.agentBrowserLogin.findMany({
    where: {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
      agentBrowser: { status: 'active' },
    },
    select: {
      id: true,
      serviceHint: true,
      createdAt: true,
      agentBrowser: { select: { agentId: true, agent: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return createApiResponse(BrowserLoginListSchema.parse({
    logins: logins.map((login) => ({
      id: login.id,
      agentId: login.agentBrowser.agentId,
      agentName: login.agentBrowser.agent.name,
      serviceHint: login.serviceHint,
      createdAt: login.createdAt.toISOString(),
    })),
  }))
})
}
