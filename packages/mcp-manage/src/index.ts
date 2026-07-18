/**
 * @nessie/mcp-manage — MCP connector management core.
 *
 * The service layer behind the `/api/mcp/*` REST surface AND the worker's
 * personal-assistant connector tools: catalog CRUD + review lifecycle,
 * instance install/probe/projection, per-principal credentials, OAuth
 * handshake helpers, the encrypted secret store, endpoint discovery, and the
 * public server library. Framework-free by design (Prisma + fetch only) so
 * both the API routes and the worker can share one implementation.
 */

export * from './auth-apply.js'
export * from './instance-secret.js'
export * from './mcp-catalog.js'
export * from './mcp-catalog-review.js'
export * from './mcp-credentials.js'
export * from './mcp-instance-errors.js'
export * from './mcp-instance-probe.js'
export * from './mcp-instance-call.js'
export * from './external-chat.js'
export * from './mcp-instances.js'
export * from './mcp-oauth.js'
export * from './mcp-oauth-secret-store.js'
export * from './mcp-security.js'
export * from './mcp-tool-registry-projection.js'
export * from './secret-resolver.js'
export * from './tool-enum-mapping.js'
export * from './library.js'
export * from './managed-products.js'
export * from './discovery.js'
export * from './oauth-discovery.js'
