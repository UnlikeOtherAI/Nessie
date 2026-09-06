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
/**
 * Answer a request whose response nobody else will write.
 *
 * Extracted so the behaviour can be tested: the failure it exists for happens
 * inside the MCP transport, which a route test cannot easily provoke, and an
 * untested error path on a hijacked socket is exactly the kind that rots into a
 * hang without anybody noticing.
 *
 * The message is deliberately bounded. An upstream error string can carry
 * another tenant's data, and a JSON-RPC error goes straight back to a client
 * that may read it into a model.
 */
export const answerHijackedFailure = (raw: {
  end: (chunk?: string) => void
  headersSent: boolean
  writeHead: (status: number, headers: Record<string, string>) => void
}): void => {
  if (raw.headersSent) {
    // The transport already started writing; the only thing left that helps is
    // not leaving the socket open.
    raw.end()
    return
  }
  raw.writeHead(500, { 'content-type': 'application/json' })
  raw.end(JSON.stringify({
    // -32603 is JSON-RPC's internal error, which is what a client reading this
    // knows how to handle.
    error: { code: -32603, message: 'Internal server error' },
    id: null,
    jsonrpc: '2.0',
  }))
}

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
      // Hijacking hands the socket to the transport, which also means Fastify's
      // error handler no longer runs for this request. Anything thrown from
      // here has to answer the client itself, or the connection simply hangs
      // until the client's own timeout — the worst failure shape available,
      // because it looks like a slow server rather than a broken one.
      reply.hijack()
      try {
        await server.connect(transport)
        await transport.handleRequest(request.raw, reply.raw, request.body)
      } catch (error) {
        console.error('[mcp] request failed', error)
        answerHijackedFailure(reply.raw)
      } finally {
        await transport.close().catch(() => undefined)
        await server.close().catch(() => undefined)
      }
      return reply
    },
  )
}
