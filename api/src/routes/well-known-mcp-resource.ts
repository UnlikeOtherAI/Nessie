import type { FastifyInstance } from 'fastify'

import { resolvePublicOrigin } from '../lib/public-origin.js'
import { sendApiError } from '../lib/api.js'
import { resolveAdminOrigin } from './mcp/oauth.js'
import type { RouteDeps } from './types.js'

/**
 * Protected Resource Metadata for the MCP endpoint (RFC 9728).
 *
 * An MCP client that hits `POST /mcp` without a credential gets a 401 and,
 * without this, no way to learn what to do about it. The spec's answer is a
 * document at a well-known path describing the resource and how to authenticate
 * to it, discovered from the `WWW-Authenticate` header on that 401.
 *
 * This deployment does not run an OAuth authorization server, so the document
 * says so plainly and points at the device-authorization endpoints instead.
 * That is more useful than advertising an `authorization_servers` list this
 * server cannot honour: a client that tried it would fail later and less
 * legibly than one told the truth up front.
 *
 * Public by design — it is read before any credential exists, and nothing in it
 * is secret.
 */
export const registerWellKnownMcpResourceRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { config } = deps

  app.get(
    '/.well-known/oauth-protected-resource',
    { config: { public: true } },
    async (request, reply) => {
      let resource: string
      try {
        resource = `${resolvePublicOrigin(request, config)}/mcp`
      } catch {
        sendApiError(
          reply,
          500,
          'PUBLIC_ORIGIN_UNCONFIGURED',
          'This deployment has no public origin configured, so it cannot describe its MCP resource.',
        )
        return reply
      }

      const adminOrigin = resolveAdminOrigin(config)

      return reply
        .header('cache-control', 'public, max-age=3600')
        .send({
          bearer_methods_supported: ['header'],
          resource,
          resource_documentation: adminOrigin
            ? `${adminOrigin}/settings/agent-access`
            : undefined,
          // Not an OAuth authorization server. Naming the grant this resource
          // actually implements is what lets a client act rather than guess.
          'x-nessie-device-authorization': {
            device_authorization_endpoint: `${resolvePublicOrigin(request, config)}/mcp/auth/device`,
            grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
            scopes_supported: [
              'boards_read',
              'boards_write',
              'documents_read',
              'documents_write',
              'documents_publish',
            ],
            token_endpoint: `${resolvePublicOrigin(request, config)}/mcp/auth/token`,
          },
        })
    },
  )
}
