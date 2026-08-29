/**
 * Catalog error vocabulary.
 *
 * Its own module so the guards and the create path can raise a catalog error
 * without importing `mcp-catalog.ts`, which imports them back. Nothing here
 * imports anything, which is what makes that chain acyclic.
 */

export const MCP_CATALOG_ERROR_CODES = {
  NOT_FOUND: 'MCP_CATALOG_ENTRY_NOT_FOUND',
  AUTH_CONFIG_INVALID: 'MCP_CATALOG_AUTH_CONFIG_INVALID',
  AUTH_METHOD_MISMATCH: 'MCP_CATALOG_AUTH_METHOD_MISMATCH',
  TRANSPORT_CONFIG_INVALID: 'MCP_CATALOG_TRANSPORT_CONFIG_INVALID',
  DUPLICATE_NAME: 'MCP_CATALOG_ENTRY_DUPLICATE_NAME',
  INVALID_TRANSITION: 'MCP_CATALOG_ENTRY_INVALID_TRANSITION',
  FORBIDDEN: 'MCP_CATALOG_ENTRY_FORBIDDEN',
  LOCKED: 'MCP_CATALOG_ENTRY_LOCKED',
} as const

export class McpCatalogError extends Error {
  override readonly name = 'McpCatalogError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}
