import type { FastifyInstance } from 'fastify'

import { WsClientMessageSchema, type WsScope } from '@nessie/schemas'
import { buildSnapshotForScopes } from '../services/agents.js'
import type { RouteDeps } from './types.js'

export const registerActivityRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    filterAuthorizedScopes,
    createAgentVisibilityScope,
  } = deps

  app.get('/api/activity', { websocket: true }, (socket, request) => {
    const actorContext = request.actorContext
    if (!actorContext) {
      socket.close(4001, 'Authentication required')
      return
    }

    const userId = actorContext.actor.actorId
    const tenantOrganizationId = actorContext.tenant.organizationId
    const wsConnection = realtimeHub.registerWsConnection({
      organizationId: tenantOrganizationId,
      userId,
      send: (message) => {
        sendJson(message)
      },
    })
    let currentScopes: WsScope[] = []
    let idleTimer: NodeJS.Timeout

    const resetIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        socket.close(4002, 'Idle timeout')
      }, 60000)
    }

    const sendJson = (value: unknown) => {
      socket.send(JSON.stringify(value))
    }

    resetIdleTimer()

    socket.on('message', async (rawMessage: Buffer) => {
      resetIdleTimer()

      let payload: unknown
      try {
        payload = JSON.parse(rawMessage.toString())
      } catch {
        sendJson({ type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON payload' })
        return
      }

      const parsed = WsClientMessageSchema.safeParse(payload)
      if (!parsed.success) {
        sendJson({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid WebSocket message' })
        return
      }

      if (parsed.data.type === 'ping') {
        sendJson({ type: 'pong', ts: new Date().toISOString() })
        return
      }

      if (parsed.data.type === 'unsubscribe') {
        const requested = new Set(parsed.data.scopes.map((scope) => JSON.stringify(scope)))
        currentScopes = currentScopes.filter((scope) => !requested.has(JSON.stringify(scope)))
        realtimeHub.setWsScopes(wsConnection, currentScopes)
        return
      }

      const nextScopes =
        parsed.data.type === 'set_subscriptions'
          ? parsed.data.scopes
          : [...currentScopes, ...parsed.data.scopes]

      currentScopes = await filterAuthorizedScopes(userId, tenantOrganizationId, nextScopes)
      realtimeHub.setWsScopes(wsConnection, currentScopes)
      const snapshot = await buildSnapshotForScopes(prisma, currentScopes, {
        visibility: createAgentVisibilityScope(actorContext),
      })

      sendJson({
        type: 'subscribed',
        scopes: currentScopes,
        snapshot,
      })
    })

    socket.on('close', () => {
      clearTimeout(idleTimer)
      realtimeHub.removeWsConnection(wsConnection)
    })
  })
}
