import { MCP_INSTANCE_ERROR_CODES, McpInstanceError } from '../mcp-instance-errors.js'
import { MCP_OAUTH_ERROR_CODES, McpOAuthError } from '../mcp-oauth.js'

/**
 * Failure codes the App Store speaks. They deliberately conceal upstream
 * endpoint details, which stay on the instance-management surface.
 */
export const APP_CONNECT_ERROR_CODES = {
  APP_NOT_FOUND: 'APP_NOT_FOUND',
  CONNECTION_NOT_FOUND: 'CONNECTION_NOT_FOUND',
  CONNECT_FORBIDDEN: 'CONNECT_FORBIDDEN',
  SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
  SERVER_INVALID: 'SERVER_INVALID',
  OAUTH_DISCOVERY_FAILED: 'OAUTH_DISCOVERY_FAILED',
  CLIENT_APPROVAL_REQUIRED: 'CLIENT_APPROVAL_REQUIRED',
  CLIENT_REGISTRATION_FAILED: 'CLIENT_REGISTRATION_FAILED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
} as const

export type AppConnectErrorCode =
  (typeof APP_CONNECT_ERROR_CODES)[keyof typeof APP_CONNECT_ERROR_CODES]

export class AppConnectError extends Error {
  override readonly name = 'AppConnectError'

  constructor(public readonly code: AppConnectErrorCode, message: string) {
    super(message)
  }
}

/** Never surfaces an upstream message; see `APP_CONNECT_ERROR_CODES`. */
export const mapHandshakeError: (error: unknown, appName: string) => never = (error, appName) => {
  if (error instanceof McpInstanceError && error.code === MCP_INSTANCE_ERROR_CODES.PROBE_FAILED) {
    throw new AppConnectError(
      APP_CONNECT_ERROR_CODES.SERVER_UNREACHABLE,
      `We couldn't reach ${appName}'s server.`,
    )
  }
  if (error instanceof McpOAuthError) {
    if (error.code === MCP_OAUTH_ERROR_CODES.URL_UNSAFE) {
      throw new AppConnectError(
        APP_CONNECT_ERROR_CODES.CONNECTION_FAILED,
        `Something went wrong while connecting to ${appName}. Nothing was saved.`,
      )
    }
    if (error.code === MCP_OAUTH_ERROR_CODES.DISCOVERY_FAILED) {
      throw new AppConnectError(
        APP_CONNECT_ERROR_CODES.OAUTH_DISCOVERY_FAILED,
        `We couldn't work out how to sign in to ${appName} automatically.`,
      )
    }
    if (error.code === MCP_OAUTH_ERROR_CODES.CLIENT_APPROVAL_REQUIRED) {
      throw new AppConnectError(
        APP_CONNECT_ERROR_CODES.CLIENT_APPROVAL_REQUIRED,
        `${appName} must approve Nessie as a sign-in client before it can connect.`,
      )
    }
    if (error.code === MCP_OAUTH_ERROR_CODES.REGISTRATION_FAILED) {
      throw new AppConnectError(
        APP_CONNECT_ERROR_CODES.CLIENT_REGISTRATION_FAILED,
        `We couldn't register Nessie with ${appName} to sign you in.`,
      )
    }
  }
  throw error
}
