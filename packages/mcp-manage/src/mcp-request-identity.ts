import type { McpTransportConfig } from '@nessie/schemas'

/**
 * Return the exact resource origin an HTTP/SSE/WS MCP server receives. UOA
 * resource delegations and signed caller context both bind to this origin.
 */
export const mcpTransportAudience = (transport: McpTransportConfig): string => {
  if (transport.transport === 'stdio') {
    throw new Error('Signed MCP request identity is unavailable for stdio transports.')
  }
  return new URL(transport.url).origin
}

/**
 * Add short-lived actor/provenance headers to a transport whose application
 * credential is already resolved. Identity headers may never replace
 * Authorization: the static app key and delegated caller are independent
 * proofs, and preserving that split is the purpose of this seam.
 */
export const applyMcpRequestIdentity = (
  transport: McpTransportConfig,
  headers: Record<string, string>,
): McpTransportConfig => {
  if (transport.transport === 'stdio') {
    throw new Error('Signed MCP request identity is unavailable for stdio transports.')
  }
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    throw new Error('MCP request identity must not replace the application credential.')
  }
  const identityHeaderNames = new Set([
    'x-nessie-context',
    'x-uoa-delegation',
  ])
  const staleHeader = Object.keys(transport.headers ?? {}).find((name) =>
    identityHeaderNames.has(name.toLowerCase()))
  if (staleHeader) {
    throw new Error(
      `MCP transport contains stale request identity header ${staleHeader}.`,
    )
  }
  const suppliedIdentityHeaders = Object.keys(headers)
    .filter((name) => identityHeaderNames.has(name.toLowerCase()))
  if (
    new Set(suppliedIdentityHeaders.map((name) => name.toLowerCase())).size
    !== suppliedIdentityHeaders.length
  ) {
    throw new Error('MCP request identity contains duplicate header names.')
  }
  return {
    ...transport,
    headers: {
      ...(transport.headers ?? {}),
      ...headers,
    },
  }
}
