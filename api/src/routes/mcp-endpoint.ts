import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance } from 'fastify'

import { createKnowledgeAccess } from './knowledge-base-access.js'
import { sendApiError } from '../lib/api.js'
import { buildNessieMcpServer } from '../mcp/server.js'
import { checkPolicy } from '../services/policy.js'
import { getTask } from '../services/tasks.js'
import type { KnowledgeAccess } from '../mcp/tool-context.js'
import type { RouteDeps } from './types.js'

/**
 * The MCP endpoint.
 *
 * `POST /mcp`, outside `/api` deliberately: `/api/mcp/*` is the connector
 * surface that manages servers Nessie calls *out* to, and putting the inbound
 * server under the same prefix would leave two opposite meanings one path
 * segment apart.
 *
 * Stateless per request. The MCP transport can hold a session id and keep a
 * stream open; this one does not, because every call carries its own credential
 * and resolves its own actor, so there is nothing to remember between them —
 * and nothing to pin a client to one replica for.
 */
export const registerMcpEndpointRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, isProjectAccessibleToActor, listAccessibleProjectIds } = deps

  // Built once: it constructs the knowledge provider, which registers the
  // indexing and publication hooks. One per request would rebuild those.
  let knowledge: KnowledgeAccess | null = null
  try {
    const access = createKnowledgeAccess(deps)
    knowledge = { buildViewer: access.buildViewer, provider: access.provider }
  } catch (error) {
    console.error('[mcp] knowledge access unavailable; document tools will refuse', error)
  }

  app.post(
    '/mcp',
    // The scope, enforced by the global hook: an agent credential reaches this
    // route and nothing else.
    { config: { agentCredential: true } },
    async (request, reply) => {
      const credential = request.agentCredential
      const actorContext = request.actorContext
      if (!credential || !actorContext) {
        // Reached only by a caller holding an ordinary session rather than an
        // agent credential. Named rather than generically refused, because a
        // person testing the endpoint with their own token deserves to know
        // why it will not work.
        sendApiError(
          reply,
          401,
          'AGENT_CREDENTIAL_REQUIRED',
          'The MCP endpoint accepts an agent access credential. Pair one with `POST /mcp/auth/device`.',
        )
        return reply
      }

      const server = buildNessieMcpServer({
        actorContext,
        authSecret: deps.authSecret,
        checkPolicy: (client, actor, resourceType, action) =>
          checkPolicy(client, actor, resourceType, action),
        // The same narrowing the task routes apply. Owners see the whole
        // organisation; everyone else is limited to their project memberships,
        // and passing `undefined` here — as an earlier draft did — would have
        // handed every agent an owner's reach over tasks.
        getTask: async (taskId) => {
          const accessible = await listAccessibleProjectIds(actorContext)
          const visibility = accessible === 'all'
            ? undefined
            : { accessibleProjectIds: accessible, actorUserId: actorContext.actor.actorId }
          return getTask(
            prisma,
            taskId,
            actorContext.tenant.organizationId,
            visibility,
          ) as never
        },
        isProjectAccessibleToActor,
        knowledge,
        prisma,
        scopes: credential.scopes,
      })

      const transport = new StreamableHTTPServerTransport({
        // Stateless: no session id to allocate, and no server-side stream to
        // keep alive between calls.
        sessionIdGenerator: undefined,
      })

      // Fastify has already read and parsed the body, so it is handed over
      // rather than re-read from the socket — the transport would otherwise
      // wait for data that has already been consumed.
      reply.hijack()
      try {
        await server.connect(transport)
        await transport.handleRequest(request.raw, reply.raw, request.body)
      } finally {
        await transport.close().catch(() => undefined)
        await server.close().catch(() => undefined)
      }
      return reply
    },
  )
}
