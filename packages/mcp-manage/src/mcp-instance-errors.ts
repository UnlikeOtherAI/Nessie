export const MCP_INSTANCE_ERROR_CODES = {
  NOT_FOUND: 'MCP_INSTANCE_NOT_FOUND',
  CATALOG_ENTRY_NOT_FOUND: 'MCP_INSTANCE_CATALOG_ENTRY_NOT_FOUND',
  DUPLICATE_SCOPE: 'MCP_INSTANCE_DUPLICATE_SCOPE',
  TRANSPORT_CONFIG_INVALID: 'MCP_INSTANCE_TRANSPORT_CONFIG_INVALID',
  PROBE_FAILED: 'MCP_INSTANCE_PROBE_FAILED',
  SCOPE_INVALID: 'MCP_INSTANCE_SCOPE_INVALID',
} as const

export class McpInstanceError extends Error {
  override readonly name = 'McpInstanceError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}
