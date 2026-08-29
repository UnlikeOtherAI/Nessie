import { McpSecurityError } from './mcp-security.js'

/**
 * Error vocabulary for the MCP OAuth handshake, in its own module the way
 * `mcp-instance-errors.ts` and `mcp-catalog-errors.ts` already are: the start
 * flow, the callback, and client registration all raise these, and none of
 * them should have to import each other to do it.
 */

export const MCP_OAUTH_ERROR_CODES = {
  INSTANCE_NOT_FOUND: 'MCP_OAUTH_INSTANCE_NOT_FOUND',
  CATALOG_ENTRY_NOT_FOUND: 'MCP_OAUTH_CATALOG_ENTRY_NOT_FOUND',
  NOT_OAUTH2: 'MCP_OAUTH_NOT_OAUTH2',
  DISCOVERY_FAILED: 'MCP_OAUTH_DISCOVERY_FAILED',
  REGISTRATION_FAILED: 'MCP_OAUTH_REGISTRATION_FAILED',
  STATE_INVALID: 'MCP_OAUTH_STATE_INVALID',
  STATE_EXPIRED: 'MCP_OAUTH_STATE_EXPIRED',
  URL_UNSAFE: 'MCP_OAUTH_URL_UNSAFE',
  TOKEN_EXCHANGE_FAILED: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED',
  TOKEN_RESPONSE_INVALID: 'MCP_OAUTH_TOKEN_RESPONSE_INVALID',
} as const

export class McpOAuthError extends Error {
  override readonly name = 'McpOAuthError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

/** An SSRF refusal reaching an OAuth caller is an OAuth error, not a leak. */
export const mapOAuthSecurityError = (error: unknown): never => {
  if (error instanceof McpSecurityError) {
    throw new McpOAuthError(MCP_OAUTH_ERROR_CODES.URL_UNSAFE, error.message)
  }
  throw error
}
