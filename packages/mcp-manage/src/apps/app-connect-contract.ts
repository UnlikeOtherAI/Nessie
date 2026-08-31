import type { PrismaClient } from '@prisma/client'
import type {
  AppConnectionStatus,
  AppDetailRecord,
  AuthorizedActionContext,
  McpCatalogAuthMethod,
  McpServerScopeType,
} from '@nessie/schemas'

import type { ManagerFactory } from '../mcp-instance-probe.js'
import type { OAuthStateStore, SecretStore } from '../mcp-oauth.js'
import type { McpUrlSafetyOptions } from '../mcp-security.js'
import type { SecretResolver } from '../secret-resolver.js'
import type { discoverMcpEndpoint } from '../discovery.js'

/** The three decisions the Connect flow can return to its caller. */
export type AppConnectOutcome =
  | { status: 'connected'; connectionId: string }
  | { status: 'authorize'; connectionId: string; authorizationUrl: string }
  | { status: 'needs_secret'; connectionId: string }

/** Dependencies shared by connect, reconnect, and custom-server connection. */
export type AppConnectContext = {
  discoverEndpoint?: typeof discoverMcpEndpoint
  prisma: PrismaClient
  actorContext: AuthorizedActionContext
  oauth: {
    callbackUrl: string
    stateStore?: OAuthStateStore
    secretStore?: SecretStore
    resolveHost?: McpUrlSafetyOptions['resolveHost']
  }
  secretResolver?: SecretResolver
  managerFactory?: ManagerFactory
}

export type ConnectAppInput = {
  /** `/apps/:slug`'s identifier — a slug, or an id for a slug-less row. */
  identifier: string
  scopeType: McpServerScopeType
  scopeId: string
}

export type ConnectAppResult = {
  app: AppDetailRecord
  outcome: AppConnectOutcome
}

export type ConnectStep = 'probe' | 'oauth' | 'secret'

/** What this app needs from this person next. */
export const chooseConnectStep = (
  authMethod: McpCatalogAuthMethod,
  hasCredential: boolean,
  reauthorize = false,
): ConnectStep => {
  if (authMethod === 'oauth2') return reauthorize || !hasCredential ? 'oauth' : 'probe'
  if (authMethod === 'none') return 'probe'
  return hasCredential ? 'probe' : 'secret'
}

export type RefreshCapabilitiesResult = {
  connectionId: string
  status: AppConnectionStatus
  toolCount: number
}

export type DisconnectedApp = {
  connectionId: string
  catalogEntryId: string
  scopeType: McpServerScopeType
  scopeId: string
}
