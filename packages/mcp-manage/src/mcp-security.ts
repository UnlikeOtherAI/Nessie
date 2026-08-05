import {
  assertSafeUrl,
  safeFetch,
  UrlSafetyError,
  type ResolveHost,
} from '@nessie/runtime'
import {
  McpTransportConfigSchema,
  type McpServerAuthConfig,
  type McpTransportConfig,
} from '@nessie/schemas'

export const MCP_SECURITY_ERROR_CODES = {
  STDIO_DISABLED: 'MCP_STDIO_DISABLED',
  URL_UNSAFE: 'MCP_URL_UNSAFE',
  TRANSPORT_CONFIG_INVALID: 'MCP_TRANSPORT_CONFIG_INVALID',
} as const

export class McpSecurityError extends Error {
  override readonly name = 'McpSecurityError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type McpUrlSafetyOptions = {
  resolveHost?: ResolveHost
}

export const parseMcpUserTransportConfig = (
  value: unknown,
): McpTransportConfig | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.transport === undefined) return null

  const parsed = McpTransportConfigSchema.safeParse(record)
  if (!parsed.success) {
    throw new McpSecurityError(
      MCP_SECURITY_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      `Invalid MCP transport config: ${parsed.error.issues[0]?.message ?? 'shape mismatch'}`,
    )
  }
  return parsed.data
}

export const assertMcpUrlSafe = async (
  rawUrl: string,
  options: McpUrlSafetyOptions = {},
): Promise<URL> => {
  try {
    return await assertSafeUrl(rawUrl, options)
  } catch (error) {
    if (error instanceof UrlSafetyError) {
      throw new McpSecurityError(
        MCP_SECURITY_ERROR_CODES.URL_UNSAFE,
        error.message,
      )
    }
    throw error
  }
}

/**
 * Outbound HTTP for MCP control-plane calls (OAuth exchange/refresh, metadata
 * discovery, dynamic client registration). Validating the URL and then calling
 * plain `fetch` leaves a rebinding window between the check and the socket, so
 * every one of those calls goes through here instead: resolve once, pin the
 * connection to the vetted IPs, and re-validate each redirect hop.
 */
export const mcpSafeFetch = async (
  rawUrl: string | URL,
  init?: RequestInit,
  options: McpUrlSafetyOptions = {},
): Promise<Response> => {
  try {
    return await safeFetch(rawUrl, init, options)
  } catch (error) {
    if (error instanceof UrlSafetyError) {
      throw new McpSecurityError(
        MCP_SECURITY_ERROR_CODES.URL_UNSAFE,
        error.message,
      )
    }
    throw error
  }
}

/**
 * `mcpSafeFetch` shaped as a drop-in for the global `fetch`, so the helpers that
 * take an injectable `fetchImpl` default to a pinned transport instead of the
 * unpinned platform one.
 */
export const pinnedMcpFetch: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : input
  return mcpSafeFetch(target, init)
}

export const assertMcpTransportSafe = async (
  config: McpTransportConfig,
  options: McpUrlSafetyOptions = {},
): Promise<void> => {
  switch (config.transport) {
    case 'stdio':
      throw new McpSecurityError(
        MCP_SECURITY_ERROR_CODES.STDIO_DISABLED,
        'MCP stdio transport is disabled for user-authored connectors',
      )
    case 'http':
    case 'sse':
    case 'ws':
      await assertMcpUrlSafe(config.url, options)
      return
    default: {
      const _never: never = config
      void _never
    }
  }
}

export const assertUserAuthoredMcpTransportSafe = async (
  value: unknown,
  options: McpUrlSafetyOptions = {},
): Promise<void> => {
  const config = parseMcpUserTransportConfig(value)
  if (!config) return
  await assertMcpTransportSafe(config, options)
}

export const assertMcpAuthUrlsSafe = async (
  config: McpServerAuthConfig,
  options: McpUrlSafetyOptions = {},
): Promise<void> => {
  if (config.method !== 'oauth2') return
  // Dynamic-mode configs carry no static URLs — endpoints are discovered from
  // server metadata and SSRF-checked at discovery time instead.
  if (config.authorizationUrl) {
    await assertMcpUrlSafe(config.authorizationUrl, options)
  }
  if (config.tokenUrl) {
    await assertMcpUrlSafe(config.tokenUrl, options)
  }
  if (config.refreshUrl) {
    await assertMcpUrlSafe(config.refreshUrl, options)
  }
}
