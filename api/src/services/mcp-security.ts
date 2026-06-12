import {
  assertSafeUrl,
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
  await assertMcpUrlSafe(config.authorizationUrl, options)
  await assertMcpUrlSafe(config.tokenUrl, options)
  if (config.refreshUrl) {
    await assertMcpUrlSafe(config.refreshUrl, options)
  }
}
