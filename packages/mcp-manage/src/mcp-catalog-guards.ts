import type { McpCatalogProtocol, McpServerAuthConfig } from '@nessie/schemas'

import { MCP_CATALOG_ERROR_CODES, McpCatalogError } from './mcp-catalog-errors.js'
import {
  McpSecurityError,
  assertMcpAuthUrlsSafe,
  assertUserAuthoredMcpTransportSafe,
} from './mcp-security.js'

/**
 * The checks every catalog write shares, and the Prisma-error readings that
 * decide how a failed write is reported.
 *
 * Extracted from `mcp-catalog.ts` so the create path can live in its own module
 * without either file importing the other.
 */

export const toJsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === 'P2002'

/**
 * A unique violation on the slug index rather than on one of the partial name
 * indexes. The two need different answers: a taken name is the author's
 * problem, a taken slug is a race the insert can simply re-resolve.
 */
export const isSlugUniqueViolation = (error: unknown): boolean => {
  if (!isUniqueViolation(error)) return false
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  const fields = Array.isArray(target) ? target : [target]
  return fields.some(
    (field) => typeof field === 'string' && field.includes('slug'),
  )
}

export const duplicateNameError = (name: string): McpCatalogError =>
  new McpCatalogError(
    MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME,
    `An MCP catalog entry named "${name}" already exists in this scope`,
  )

export const transportConfigError = (message: string): McpCatalogError =>
  new McpCatalogError(MCP_CATALOG_ERROR_CODES.TRANSPORT_CONFIG_INVALID, message)

const mapSecurityError = (error: unknown): never => {
  if (error instanceof McpSecurityError) {
    throw transportConfigError(error.message)
  }
  throw error
}

const assertCatalogProtocolSafe = (protocol: McpCatalogProtocol): void => {
  if (protocol === 'stdio') {
    throw transportConfigError(
      'MCP stdio transport is disabled for user-authored connectors',
    )
  }
}

export const assertCatalogSecurity = async (
  input: {
    authConfig?: McpServerAuthConfig
    defaultTransportConfig?: unknown
    protocol?: McpCatalogProtocol
  },
): Promise<void> => {
  if (input.protocol) assertCatalogProtocolSafe(input.protocol)
  try {
    if (input.authConfig) {
      await assertMcpAuthUrlsSafe(input.authConfig)
    }
    await assertUserAuthoredMcpTransportSafe(input.defaultTransportConfig)
  } catch (error) {
    mapSecurityError(error)
  }
}
