import type { McpCatalogAuthMethod, McpServerAuthConfig } from '@nessie/schemas'
import type { OfferableTransport } from './connector-transports'

/**
 * Pure config builders + option lists for the "Add MCP server" wizard. These
 * shape raw form fields into the typed transport/auth payloads the API expects.
 * The transport options themselves live in `./connector-transports`, which
 * explains why the wizard offers only what a user-authored connector can run.
 */

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
  protocol: OfferableTransport,
  raw: { url: string },
): Record<string, unknown> => ({ transport: protocol, url: raw.url.trim() })
