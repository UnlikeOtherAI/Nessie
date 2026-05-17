import type { FastifyInstance } from 'fastify'

import { inMemorySecretStoreStub } from '../services/mcp-oauth.js'

import { registerMcpCatalogRoutes } from './mcp/catalog.js'
import { registerMcpCredentialRoutes } from './mcp/credentials.js'
import { registerMcpInstanceRoutes } from './mcp/instances.js'
import { registerMcpOAuthRoutes } from './mcp/oauth.js'
import { registerMcpToolsRoutes } from './mcp/tools.js'
import type { McpRouteHelpers, McpSubRegistrarContext } from './mcp/shared.js'

/**
 * Owner-only HTTP surface for the MCP universal connector (plan §6, spec
 * `docs/external-tool-integration.md` §2 and `docs/tool-registry-spec.md` §3.1).
 *
 * This file is intentionally a thin shim: it resolves the OAuth secret store
 * (with a production guard) and then delegates each topic to its own
 * sub-registrar. The per-topic logic + body schemas live under
 * `./mcp/{catalog,instances,credentials,tools,oauth}.ts` to keep every file
 * comfortably under the 500-line cap (AGENTS.md).
 */

// Re-export public types + symbols so existing test imports
// (`from '../src/routes/mcp.js'`) keep working without churn.
export type { McpRouteHelpers } from './mcp/shared.js'
export {
  attachGrantsToRegistryEntries,
  CreateGrantBodySchema,
  type ToolRegistryEntryWithGrants,
} from './mcp/tools.js'

export const registerMcpRoutes = (
  app: FastifyInstance,
  helpers: McpRouteHelpers,
): void => {
  // Production deployments MUST inject a KMS-backed `SecretStore`. The default
  // `inMemorySecretStoreStub` only mints opaque refs and never persists token
  // material, so any OAuth handshake completed against it silently drops the
  // access/refresh tokens. Fail loud at startup rather than discover the
  // data-loss bug after a user authorizes a third-party app.
  //
  // This guard MUST run before any sub-registrar is invoked so the throw
  // happens exactly once, at registration time, with a clear message — not
  // deep inside a request handler where the failure mode is opaque.
  const oauthSecretStore = helpers.oauthSecretStore ?? (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[mcp] OAuth SecretStore not configured. registerMcpRoutes() was '
          + 'called without `oauthSecretStore` while NODE_ENV=production. '
          + 'The in-memory stub does NOT persist tokens — completing an OAuth '
          + 'handshake against it would silently drop credentials. Wire a '
          + 'KMS-backed SecretStore before starting the API in production.',
      )
    }
    app.log.warn(
      '[mcp] No OAuth SecretStore configured — falling back to '
        + '`inMemorySecretStoreStub`. Tokens will NOT be persisted; this is '
        + 'safe for tests and local dev only.',
    )
    return inMemorySecretStoreStub()
  })()

  const ctx: McpSubRegistrarContext = {
    prisma: helpers.prisma,
    requireActorContext: helpers.requireActorContext,
    requireOwner: helpers.requireOwner,
    oauthSecretStore,
  }

  registerMcpCatalogRoutes(app, ctx)
  registerMcpInstanceRoutes(app, ctx)
  registerMcpCredentialRoutes(app, ctx)
  registerMcpToolsRoutes(app, ctx)
  registerMcpOAuthRoutes(app, ctx)
}
