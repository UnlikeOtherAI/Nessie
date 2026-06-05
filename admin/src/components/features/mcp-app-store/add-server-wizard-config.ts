import type {
  McpCatalogAuthMethod,
  McpCatalogProtocol,
  McpServerAuthConfig,
} from '@nessie/schemas'

/**
 * Pure config builders + option lists for the "Add MCP server" wizard. These
 * shape raw form fields into the typed transport/auth payloads the API expects.
 */

export const PROTOCOLS: McpCatalogProtocol[] = ['stdio', 'http', 'sse', 'ws']
export const AUTH_METHODS: McpCatalogAuthMethod[] = [
  'api_key',
  'bearer',
  'basic',
  'oauth2',
  'none',
]

export const buildAuthConfig = (
  method: McpCatalogAuthMethod,
  raw: {
    headerName: string
    valuePrefix: string
    authorizationUrl: string
    tokenUrl: string
    clientId: string
    clientSecret: string
    scopes: string
  },
): McpServerAuthConfig => {
  switch (method) {
    case 'api_key':
      return {
        method: 'api_key',
        headerName: raw.headerName.trim() || 'Authorization',
        valuePrefix: raw.valuePrefix,
      }
    case 'oauth2':
      return {
        method: 'oauth2',
        authorizationUrl: raw.authorizationUrl.trim(),
        tokenUrl: raw.tokenUrl.trim(),
        clientId: raw.clientId.trim(),
        clientSecret: raw.clientSecret,
        scopes: raw.scopes
          .split(/[\s,]+/)
          .map((scope) => scope.trim())
          .filter(Boolean),
      }
    case 'bearer':
      return { method: 'bearer' }
    case 'basic':
      return { method: 'basic' }
    case 'none':
      return { method: 'none' }
  }
}

export const buildTransportConfig = (
  protocol: McpCatalogProtocol,
  raw: { url: string; command: string; args: string },
): Record<string, unknown> => {
  switch (protocol) {
    case 'http':
    case 'sse':
      return { transport: protocol, url: raw.url.trim() }
    case 'stdio':
      return {
        transport: 'stdio',
        command: raw.command.trim(),
        args: raw.args
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(Boolean),
      }
    case 'ws':
      return { transport: 'ws', url: raw.url.trim() }
  }
}
