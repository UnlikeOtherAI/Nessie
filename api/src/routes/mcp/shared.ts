import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { sendApiError } from '../../lib/api.js'
import type { AppConfig } from '../../lib/server-context.js'
import type { RateLimiter } from '../../services/rate-limit.js'
import {
  McpCatalogError,
  MCP_CATALOG_ERROR_CODES,
  McpCredentialError,
  MCP_CREDENTIAL_ERROR_CODES,
  McpInstanceError,
  MCP_INSTANCE_ERROR_CODES,
  McpOAuthError,
  MCP_OAUTH_ERROR_CODES,
  type OAuthStateStore,
  type SecretResolver,
  type SecretStore,
} from '@nessie/mcp-manage'
import { ToolGrantError, TOOL_GRANT_ERROR_CODES } from '../../services/tool-grants.js'
import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
} from '../../services/agent-tool-policy.js'

/**
 * Shared types + helpers for the per-topic MCP sub-registrars.
 *
 * The sub-files (`catalog.ts`, `instances.ts`, `credentials.ts`, `tools.ts`,
 * `oauth.ts`) each receive the same `McpSubRegistrarContext` so they can be
 * registered independently from `routes/mcp.ts`. Keep this file dependency-light
 * — anything topic-specific lives in the relevant sub-file.
 */

export type McpRouteHelpers = {
  prisma: PrismaClient
  /**
   * API config (rate-limit thresholds) + the brute-force limiter used by the
   * OAuth handshake and credential-write sub-registrars. Optional so existing
   * unit fixtures stay minimal; production wiring in index.ts always sets
   * them, and registerMcpRoutes falls back to defaults + a fail-open in-memory
   * limiter when absent.
   */
  config?: AppConfig
  rateLimiter?: RateLimiter
  requireActorContext: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AuthorizedActionContext | null
  requireOwner: (actorContext: AuthorizedActionContext, reply: FastifyReply) => boolean
  /**
   * Override the OAuth secret store for tests. Production should always wire
   * a KMS-backed implementation (`SecretStore.put` must persist plaintext
   * outside process memory). The default `inMemorySecretStoreStub` only ships
   * a placeholder ref and is NOT safe for real credentials.
   */
  oauthSecretStore?: SecretStore
  /**
   * Resolver for `credentialRef` values on probe/test paths. Production wires
   * the layered pg+env resolver (`createMcpSecretResolver`) so OAuth tokens
   * and assistant-collected secrets resolve exactly like env-provisioned refs.
   */
  secretResolver?: SecretResolver
  /**
   * Store for user-provided connector credentials (the instance `/secret`
   * route). Defaults to the OAuth secret store when omitted.
   */
  mcpSecretStore?: SecretStore
  /**
   * OAuth authorization state store. Defaults to the Postgres-backed store
   * (cross-process one-shot state); tests may inject an in-memory one.
   */
  oauthStateStore?: OAuthStateStore
}

/**
 * What each per-topic sub-registrar receives. Identical to `McpRouteHelpers`
 * except `oauthSecretStore` has been resolved (defaulted, or thrown loud in
 * production when missing). Keep this type in lock-step with the resolution
 * logic inside `registerMcpRoutes` so sub-files can rely on a present store.
 */
export type McpSubRegistrarContext = {
  prisma: PrismaClient
  config: AppConfig
  rateLimiter: RateLimiter
  requireActorContext: McpRouteHelpers['requireActorContext']
  requireOwner: McpRouteHelpers['requireOwner']
  oauthSecretStore: SecretStore
  secretResolver: SecretResolver
  mcpSecretStore: SecretStore
  oauthStateStore?: OAuthStateStore
}

export const JsonRecordSchema = z.record(z.string(), z.unknown())

/**
 * Translate a service-layer error into a Fastify reply. Returns true if the
 * error was recognised and a response was sent, false otherwise (caller must
 * re-throw to surface as a 500 via the Fastify error handler).
 */
export const sendMcpError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof AgentToolPolicyError) {
    const status =
      error.code === AGENT_TOOL_POLICY_ERROR_CODES.AGENT_NOT_FOUND
        || error.code === AGENT_TOOL_POLICY_ERROR_CODES.TOOL_NOT_FOUND
        ? 404
        : error.code === AGENT_TOOL_POLICY_ERROR_CODES.ACTIVE_RUNS
          || error.code === AGENT_TOOL_POLICY_ERROR_CODES.DEPENDENCY_REQUIRED
          ? 409
        : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof McpCatalogError) {
    const status =
      error.code === MCP_CATALOG_ERROR_CODES.NOT_FOUND
        ? 404
        : error.code === MCP_CATALOG_ERROR_CODES.FORBIDDEN
            || error.code === MCP_CATALOG_ERROR_CODES.LOCKED
          ? 403
          // `DUPLICATE_NAME` and `INVALID_TRANSITION` both describe a
          // pre-existing resource that conflicts with the requested mutation
          // (RFC 7231 §6.5.8) — return 409 so clients can distinguish a
          // schema problem (400) from a lifecycle conflict (409).
          : error.code === MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME
              || error.code === MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION
            ? 409
            : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof McpInstanceError) {
    const status =
      error.code === MCP_INSTANCE_ERROR_CODES.NOT_FOUND
        || error.code === MCP_INSTANCE_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND
        ? 404
        : error.code === MCP_INSTANCE_ERROR_CODES.LOCKED
          ? 403
          : error.code === MCP_INSTANCE_ERROR_CODES.DUPLICATE_SCOPE
              || error.code === MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION
          ? 409
          : error.code === MCP_INSTANCE_ERROR_CODES.PROBE_FAILED
            ? 502
            : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof McpCredentialError) {
    const status =
      error.code === MCP_CREDENTIAL_ERROR_CODES.INSTANCE_NOT_FOUND
        || error.code === MCP_CREDENTIAL_ERROR_CODES.OVERRIDE_NOT_FOUND
        ? 404
        : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof ToolGrantError) {
    const status =
      error.code === TOOL_GRANT_ERROR_CODES.TOOL_NOT_FOUND
        || error.code === TOOL_GRANT_ERROR_CODES.GRANT_NOT_FOUND
        ? 404
        : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  if (error instanceof McpOAuthError) {
    const status =
      error.code === MCP_OAUTH_ERROR_CODES.INSTANCE_NOT_FOUND
        || error.code === MCP_OAUTH_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND
        ? 404
        : error.code === MCP_OAUTH_ERROR_CODES.STATE_INVALID
            || error.code === MCP_OAUTH_ERROR_CODES.STATE_EXPIRED
          ? 400
          : error.code === MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED
              || error.code === MCP_OAUTH_ERROR_CODES.TOKEN_RESPONSE_INVALID
            ? 502
            // `NOT_OAUTH2` means the catalog entry exists but its auth method
            // disallows the OAuth handshake — a lifecycle conflict, not a
            // payload validation failure. Surface as 409 (RFC 7231 §6.5.8).
            : error.code === MCP_OAUTH_ERROR_CODES.NOT_OAUTH2
              ? 409
              : 400
    sendApiError(reply, status, error.code, error.message)
    return true
  }
  return false
}
