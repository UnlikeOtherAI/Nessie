import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Prisma, PrismaClient } from '@prisma/client'
import { connectCloudBrowser, disconnectCloudBrowser, isCloudBrowserError, listCloudBrowserConnections } from '@nessie/browser-cloud'
import { createPgSecretStore } from '@nessie/mcp-manage'

import { CloudBrowserConnectionListSchema, ConnectCloudBrowserBodySchema } from '../contracts/browser-cloud.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const sendConnectionError = (reply: FastifyReply, error: unknown): boolean => {
  if (!isCloudBrowserError(error)) return false
  const status = error.code === 'CLOUD_BROWSER_NO_CONNECTION' ? 404
    : error.code === 'CLOUD_BROWSER_AUTH_FAILED' ? 400
    : error.code === 'CLOUD_BROWSER_CAPACITY' ? 409
    : error.code === 'CLOUD_BROWSER_UNTRUSTED_ENDPOINT' || error.code === 'CLOUD_BROWSER_UNREACHABLE' ? 502 : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}

export const registerBrowserCloudConnectionRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { authSecret, prisma, requireActorContext, requireOwner, requireUserActor } = deps
  const connectionDeps = {
    prisma,
    storeSecret: (tx: PrismaClient | Prisma.TransactionClient, apiKey: string) => createPgSecretStore(
      tx,
      authSecret ?? '',
      { refPrefix: 'secret_browserbase_' },
    ).put({ accessToken: apiKey }),
  }
  app.get('/api/browser-cloud/connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const connections = await listCloudBrowserConnections(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(
      CloudBrowserConnectionListSchema.parse({
        connections: connections.map((row) => ({
          id: row.id,
          scope: row.scope,
          projectId: row.projectId,
          status: row.status,
          healthReason: row.healthReason,
          healthDetail: row.healthDetail,
          createdAt: row.createdAt.toISOString(),
          liveSessions: row.liveSessions,
          usedMinutes: row.usedMinutes,
          isMine: row.scope === 'user' && row.userId === actorContext.actor.actorId,
        })),
      }),
    )
  })

  app.post('/api/browser-cloud/connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(ConnectCloudBrowserBodySchema, request.body, reply)
    if (!body) return reply

    // The company and team subscriptions are owner decisions; a personal
    // account is anyone's own business and lands on their own row.
    if (body.scope !== 'user' && !requireOwner(actorContext, reply)) return reply

    if (body.scope === 'team') {
      if (!body.teamId) {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'A team account needs a team.')
        return reply
      }
      // Teams carry no organization_id of their own — tenancy runs through
      // their project — so the FK cannot make this check for us. The refusal
      // is indistinguishable from a team that does not exist.
      const team = await prisma.team.findFirst({
        where: {
          id: body.teamId,
          project: { organizationId: actorContext.tenant.organizationId },
        },
        select: { id: true },
      })
      if (!team) {
        sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
        return reply
      }
    }

    try {
      const result = await connectCloudBrowser(connectionDeps, {
        organizationId: actorContext.tenant.organizationId,
        scope: body.scope,
        teamId: body.scope === 'team' ? body.teamId ?? null : null,
        userId: body.scope === 'user' ? actorContext.actor.actorId : null,
        actingUserId: actorContext.actor.actorId,
        apiKey: body.apiKey,
        projectId: body.projectId,
      })
      return reply.code(201).send(createApiResponse({ id: result.id }))
    } catch (error) {
      if (sendConnectionError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/browser-cloud/connections/:connectionId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { connectionId } = request.params as { connectionId: string }
    const row = await prisma.cloudBrowserConnection.findFirst({
      where: { id: connectionId, organizationId: actorContext.tenant.organizationId },
      select: { scope: true, userId: true },
    })
    if (!row) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_NO_CONNECTION', 'That browser connection does not exist.')
      return reply
    }
    // Disconnecting a shared account is an owner act; a personal one is only
    // ever its own owner's.
    if (row.scope !== 'user') {
      if (!requireOwner(actorContext, reply)) return reply
    } else if (row.userId !== actorContext.actor.actorId) {
      sendApiError(reply, 404, 'CLOUD_BROWSER_NO_CONNECTION', 'That browser connection does not exist.')
      return reply
    }

    try {
      await disconnectCloudBrowser(prisma, {
        organizationId: actorContext.tenant.organizationId,
        connectionId,
      })
      return reply.code(204).send()
    } catch (error) {
      if (sendConnectionError(reply, error)) return reply
      throw error
    }
  })

}
