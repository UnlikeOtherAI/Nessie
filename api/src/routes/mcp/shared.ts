import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { sendApiError } from '../../lib/api.js'
import { McpCatalogError, MCP_CATALOG_ERROR_CODES } from '../../services/mcp-catalog.js'
import { McpInstanceError, MCP_INSTANCE_ERROR_CODES } from '../../services/mcp-instances.js'
import { McpOAuthError, MCP_OAUTH_ERROR_CODES, type SecretStore } from '../../services/mcp-oauth.js'
import {
  McpCredentialError,
  MCP_CREDENTIAL_ERROR_CODES,
} from '../../services/mcp-credentials.js'
import { ToolGrantError, TOOL_GRANT_ERROR_CODES } from '../../services/tool-grants.js'

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
}

/**
 * What each per-topic sub-registrar receives. Identical to `McpRouteHelpers`
 * except `oauthSecretStore` has been resolved (defaulted, or thrown loud in
 * production when missing). Keep this type in lock-step with the resolution
 * logic inside `registerMcpRoutes` so sub-files can rely on a present store.
 */
export type McpSubRegistrarContext = {
  prisma: PrismaClient
  requireActorContext: McpRouteHelpers['requireActorContext']
  requireOwner: McpRouteHelpers['requireOwner']
  oauthSecretStore: SecretStore
}

export const JsonRecordSchema = z.record(z.string(), z.unknown())

/**
 * Translate a service-layer error into a Fastify reply. Returns true if the
 * error was recognised and a response was sent, false otherwise (caller must
 * re-throw to surface as a 500 via the Fastify error handler).
 */
export const sendMcpError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof McpCatalogError) {
    const status =
      error.code === MCP_CATALOG_ERROR_CODES.NOT_FOUND
        ? 404
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
        : error.code === MCP_INSTANCE_ERROR_CODES.DUPLICATE_SCOPE
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
