import type { McpServerScopeType } from '@nessie/schemas'

import { getCatalogEntry, type McpCatalogEntryRow } from '../mcp-catalog.js'
import { McpCredentialError, resolveCredentialRef } from '../mcp-credentials.js'
import { MCP_INSTANCE_ERROR_CODES, McpInstanceError } from '../mcp-instance-errors.js'
import { refreshInstance, testInstance } from '../mcp-instance-testing.js'
import {
  createInstance,
  deleteInstance,
  getInstance,
  type McpInstanceRow,
} from '../mcp-instances.js'
import { resolveInstanceTransport } from '../mcp-instance-probe.js'
import { canStartOAuthForInstance } from '../mcp-oauth-completion.js'
import { startOAuth } from '../mcp-oauth.js'
import { discoverMcpEndpoint } from '../discovery.js'

import { captureConnectionCapabilities } from './app-capabilities.js'
import { deriveConnectionStatus } from './app-connections.js'
import { canManageAppConnectionScope } from './app-connection-management.js'
import {
  chooseConnectStep,
  type AppConnectContext,
  type AppConnectOutcome,
  type ConnectAppInput,
  type ConnectAppResult,
  type DisconnectedApp,
  type RefreshCapabilitiesResult,
} from './app-connect-contract.js'
import {
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  mapHandshakeError,
} from './app-connect-errors.js'
import { getStoreApp } from './app-store-detail.js'

export * from './app-connect-contract.js'
export * from './app-connect-errors.js'

/**
 * The universal Connect flow, as an **orchestration of what already exists**.
 * Spec: `docs/plans/2026-08-29-apps-catalogue/ux-design-detail-and-connect.md`
 * §2 (connect), §3 (connection management).
 *
 * Nothing here is a second implementation of anything. Instance creation with
 * its scope validation, admin endpoint lock and SSRF guard is `createInstance`;
 * the handshake and tool projection are `testInstance`; RFC 9728/8414
 * discovery, RFC 7591 registration, PKCE and RFC 8707 are `startOAuth`; the
 * encrypted token vault and its auto-refresh are the secret store and resolver.
 * Connect's own contribution is exactly one decision — *which* of those a
 * person needs next — plus the vocabulary the store speaks it in. So what a
 * caller gets back is that decision, not a connector row: `connected` (nothing
 * more to do), `authorize` (send them to the provider), or `needs_secret` (the
 * existing credential dialog owns the rest).
 */

// ─── Internals ──────────────────────────────────────────────────────────────

// Annotated on the binding, not only on the arrow: TypeScript treats a call as
// never-returning (and narrows after it) only when the variable itself carries
// an explicit type.
const appNotFound: () => never = () => {
  // An app hidden by tenancy, moderation or trust answers exactly as one that
  // never existed — the same silence `GET /api/apps/:slug` keeps.
  throw new AppConnectError(APP_CONNECT_ERROR_CODES.APP_NOT_FOUND, 'App not found')
}

const connectionNotFound: () => never = () => {
  throw new AppConnectError(
    APP_CONNECT_ERROR_CODES.CONNECTION_NOT_FOUND,
    'Connected account not found',
  )
}

const forbidden: (message: string) => never = (message) => {
  throw new AppConnectError(APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN, message)
}

/**
 * The caller's credential for this instance, or nothing. A user-scope mismatch
 * is a refusal to resolve somebody else's secret, which for this question is
 * simply "you have no credential here" — connect then offers to make one
 * rather than failing.
 */
const resolveCallerCredential = async (
  ctx: AppConnectContext,
  instance: McpInstanceRow,
): Promise<string | null> => {
  try {
    return await resolveCredentialRef(ctx.prisma, instance.id, {
      userId: ctx.actorContext.actor.actorId,
      organizationId: ctx.actorContext.tenant.organizationId,
    })
  } catch (error) {
    if (error instanceof McpCredentialError) return null
    throw error
  }
}

/**
 * Probe, sign in, or ask for a key — the shared body of connect, reconnect and
 * the custom-server path. They differ only in how they arrived at an instance,
 * which is why this is one function rather than three similar ones.
 */
type ConnectCatalogEntry = Pick<McpCatalogEntryRow, 'id' | 'label' | 'authMethod'> & {
  /** Present on catalogue rows; optional for focused callers of this exported helper. */
  defaultTransportConfig?: unknown
}

/**
 * The effective remote endpoint a probe used, or null when the resolved
 * transport is local. This deliberately follows `resolveInstanceTransport`,
 * so an App Store instance with no override retains its catalogue default.
 */
const instanceEndpointUrl = (
  instance: McpInstanceRow,
  catalogEntry: Pick<ConnectCatalogEntry, 'defaultTransportConfig'>,
): string | null => {
  try {
    const transport = resolveInstanceTransport(instance, {
      defaultTransportConfig: catalogEntry.defaultTransportConfig ?? {},
    })
    return transport.transport === 'http' || transport.transport === 'sse'
      ? transport.url
      : null
  } catch {
    // The failed probe already records malformed transport configuration; an
    // auth follow-up must not replace that outcome with a second error.
    return null
  }
}

/**
 * A probe that failed may mean the server is down — or that it answered "you
 * need to sign in", which is a different fact with a different remedy.
 *
 * The MCP authorization spec says a server states its auth by refusing an
 * unauthenticated request and pointing at its metadata (RFC 9728). Nessie has
 * always implemented that in `discoverMcpEndpoint`; the App Store connect path
 * simply never reached it, because `chooseConnectStep` trusted the catalogue's
 * `authMethod` — and on a registry-ingested row that value is the column
 * default, not a statement anybody made. GitLab's official server is the case
 * in point: it answers 401 with
 * `WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource/api/v4/mcp"`,
 * advertises an authorization server and even a DCR registration endpoint —
 * everything this codebase already speaks — and the store still told people
 * "we couldn't reach the server", for 4,685 of 5,548 rows.
 *
 * So a failed probe asks the server what it wants before giving up.
 */
const learnAuthFromServer = async (
  ctx: AppConnectContext,
  entry: Pick<ConnectCatalogEntry, 'id' | 'authMethod' | 'defaultTransportConfig'>,
  instance: McpInstanceRow,
): Promise<'oauth2' | 'secret' | null> => {
  // A human-authored entry already states its auth; only a defaulted one is
  // worth re-deriving, and only that one may be overwritten below. `appSource`
  // is read here rather than widened into `McpCatalogEntryRow`, which flows
  // through every catalogue caller for a field only this decision needs.
  if (entry.authMethod !== 'none') return null
  const row = await ctx.prisma.mcpCatalogEntry.findUnique({
    select: { appSource: true },
    where: { id: entry.id },
  })
  if (row?.appSource !== 'mcp_registry') return null
  const endpoint = instanceEndpointUrl(instance, entry)
  if (!endpoint) return null

  // Injected so a unit test never dials a real host; production takes the
  // shared, SSRF-pinned implementation.
  const discover = ctx.discoverEndpoint ?? discoverMcpEndpoint
  const discovered = await discover(endpoint).catch(() => null)
  const method = discovered?.proposal?.authMethod ?? null
  if (method === 'oauth2') {
    // Persist what the server said, so the next person sees "Connecting opens
    // a sign-in window" before clicking and `startOAuth`'s own guard passes.
    // `{ method: 'oauth2' }` with no static client is exactly the dynamic
    // shape: discovery, DCR, then PKCE.
    await ctx.prisma.mcpCatalogEntry.update({
      data: { authConfig: { method: 'oauth2' }, authMethod: 'oauth2' },
      where: { id: entry.id },
    })
    return 'oauth2'
  }
  if (method === 'bearer') {
    // Bearer discovery is just as durable a fact as OAuth discovery. Without
    // this write the first probe sends the person to the key panel, but the
    // retry still treats the server as unauthenticated and omits their key.
    await ctx.prisma.mcpCatalogEntry.update({
      data: { authConfig: { method: 'bearer' }, authMethod: 'bearer' },
      where: { id: entry.id },
    })
    return 'secret'
  }
  // Discovery can establish that a key is needed, but not which header an
  // arbitrary API-key server expects. Keep that uncertainty in the temporary
  // key-panel outcome rather than persisting a guessed API-key configuration.
  return method === 'api_key' ? 'secret' : null
}

export const runConnectHandshake = async (
  ctx: AppConnectContext,
  entry: ConnectCatalogEntry,
  instance: McpInstanceRow,
  options: { reauthorize?: boolean } = {},
): Promise<AppConnectOutcome> => {
  const credentialRef = await resolveCallerCredential(ctx, instance)
  const step = chooseConnectStep(
    entry.authMethod,
    credentialRef !== null,
    options.reauthorize ?? false,
  )
  if (step === 'secret') {
    return { status: 'needs_secret', connectionId: instance.id }
  }
  // The two steps carry different rights because they do different things.
  // `oauth` mints a credential for the caller's own identity — all that reaching
  // a connection has ever authorised. A probe is a shared *write*: `testInstance`
  // rewrites `lifecycleState`, `discoveredTools`, the failure counter and
  // `lastError` on the account everyone at that scope uses and re-projects its
  // tool rows, so it takes the manage right its own route
  // (`POST /api/mcp/instances/:id/test`) requires. Otherwise a member could flip
  // a shared connector to `error` for the organisation by connecting at a moment
  // the upstream was down.
  if (step === 'probe' && !(await canManageAppConnectionScope(ctx, instance.scopeType, instance.scopeId))) {
    forbidden('You do not have permission to verify this connected account')
  }

  try {
    if (step === 'oauth') {
      const flow = await startOAuth({
        prisma: ctx.prisma,
        store: ctx.oauth.stateStore,
        secretStore: ctx.oauth.secretStore,
        instanceId: instance.id,
        actorContext: ctx.actorContext,
        callbackUrl: ctx.oauth.callbackUrl,
        discovery: ctx.oauth.discovery,
        resolveHost: ctx.oauth.resolveHost,
      })
      return {
        status: 'authorize',
        connectionId: instance.id,
        authorizationUrl: flow.authorizationUrl,
      }
    }
    await testInstance(
      ctx.prisma,
      ctx.actorContext.tenant.organizationId,
      instance.id,
      {
        probeUserId: ctx.actorContext.actor.actorId,
        secretResolver: ctx.secretResolver,
        managerFactory: ctx.managerFactory,
      },
    )
    // What the app can do, cached where the store reads it; best-effort by
    // construction (see `captureConnectionCapabilities`).
    await captureConnectionCapabilities(ctx, instance)
    return { status: 'connected', connectionId: instance.id }
  } catch (error) {
    // Before calling it unreachable, ask the server what it wants. A 401
    // carrying RFC 9728 metadata is a working server stating its terms.
    if (
      error instanceof McpInstanceError
      && error.code === MCP_INSTANCE_ERROR_CODES.PROBE_FAILED
    ) {
      const learned = await learnAuthFromServer(ctx, entry, instance)
      if (learned === 'secret') {
        return { status: 'needs_secret', connectionId: instance.id }
      }
      if (learned === 'oauth2') {
        // Re-enter through the declared OAuth path, so a discovery or client
        // registration failure keeps the same Apps-safe error vocabulary.
        return runConnectHandshake(ctx, { ...entry, authMethod: 'oauth2' }, instance)
      }
    }
    return mapHandshakeError(error, entry.label)
  }
}

/**
 * The connection for this app at this scope, adopting the row that is already
 * there rather than colliding with it: two people connecting the same shared
 * app are one connected account, and a second attempt after a cancelled
 * sign-in must resume rather than answer 409.
 *
 * The two paths carry different rights on purpose. *Creating* a connection at
 * a scope is the connector surface's manage right; *reaching* one that already
 * exists is `canStartOAuthForInstance` — enough to mint a credential for the
 * caller's own identity and no more, which is why `runConnectHandshake` gates
 * its probe separately rather than treating reach as permission to write.
 */
export const resolveConnection = async (
  ctx: AppConnectContext,
  catalogEntryId: string,
  scopeType: McpServerScopeType,
  scopeId: string,
): Promise<McpInstanceRow> => {
  const organizationId = ctx.actorContext.tenant.organizationId
  const existing = await ctx.prisma.mcpServerInstance.findFirst({
    where: { organizationId, catalogEntryId, scopeType, scopeId },
  })
  if (existing) {
    const allowed = await canStartOAuthForInstance(
      ctx.prisma,
      organizationId,
      ctx.actorContext.actor.actorId,
      existing,
    )
    if (!allowed) forbidden('You do not have access to this connected account')
    return existing
  }
  if (!(await canManageAppConnectionScope(ctx, scopeType, scopeId))) {
    forbidden('You do not have permission to connect apps at this scope')
  }
  try {
    return await createInstance(ctx.prisma, ctx.actorContext, {
      catalogEntryId,
      scopeType,
      scopeId,
      // Installing an app is not the same decision as letting an agent use it
      // (the brief separates INSTALL from ASSIGN). Set only on the create
      // branch: an existing connection keeps the open rows it already had, and
      // no agent loses a tool it is using today.
      requiresExplicitToolGrant: true,
    })
  } catch (error) {
    // The transport guard quotes the address it refused. Every other install
    // refusal (locked, duplicate scope, integration-managed) names a label or
    // a caller-supplied id and travels as it is.
    if (
      error instanceof McpInstanceError
      && error.code === MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID
    ) {
      throw new AppConnectError(
        APP_CONNECT_ERROR_CODES.SERVER_INVALID,
        'This app is not configured with an address we can reach.',
      )
    }
    throw error
  }
}

// ─── Connect ────────────────────────────────────────────────────────────────

export const connectApp = async (
  ctx: AppConnectContext,
  input: ConnectAppInput,
): Promise<ConnectAppResult> => {
  // The store's own resolver decides identity and visibility, so an app the
  // catalogue would not show is not connectable by guessing its slug either.
  const app = await getStoreApp(ctx.prisma, ctx.actorContext, input.identifier)
  if (!app) appNotFound()
  const entry = await getCatalogEntry(
    ctx.prisma,
    ctx.actorContext.tenant.organizationId,
    app.id,
  )
  if (!entry) appNotFound()

  const instance = await resolveConnection(ctx, entry.id, input.scopeType, input.scopeId)
  return { app, outcome: await runConnectHandshake(ctx, entry, instance) }
}

// ─── One connected account ──────────────────────────────────────────────────

const loadConnection = async (
  ctx: AppConnectContext,
  connectionId: string,
): Promise<{ instance: McpInstanceRow; entry: McpCatalogEntryRow }> => {
  const organizationId = ctx.actorContext.tenant.organizationId
  const instance = await getInstance(ctx.prisma, organizationId, connectionId)
  if (!instance) connectionNotFound()
  const entry = await getCatalogEntry(ctx.prisma, organizationId, instance.catalogEntryId)
  if (!entry) appNotFound()
  return { instance, entry }
}

/** Sign in again — see `chooseConnectStep` for why this never probes first. */
export const reconnectAppConnection = async (
  ctx: AppConnectContext,
  connectionId: string,
): Promise<AppConnectOutcome> => {
  const { instance, entry } = await loadConnection(ctx, connectionId)
  const allowed = await canStartOAuthForInstance(
    ctx.prisma,
    ctx.actorContext.tenant.organizationId,
    ctx.actorContext.actor.actorId,
    instance,
  )
  if (!allowed) forbidden('You do not have access to this connected account')
  return runConnectHandshake(ctx, entry, instance, { reauthorize: true })
}

/**
 * Re-probe and re-project, so the Capabilities tab reflects what the server
 * offers today. `refreshInstance` returns the row even when the probe failed,
 * which is what lets this answer "still unreachable" instead of throwing at
 * somebody who asked a maintenance question.
 *
 * The catalogue row's cached counts (`toolCount`/`resourceCount`/`promptCount`
 * + `capabilitiesAt`) and the app's health row are capability discovery's to
 * write, and this is the call site they belong on — a failed probe included,
 * because "unavailable" is exactly the fact a card needs.
 */
export const refreshAppConnectionCapabilities = async (
  ctx: AppConnectContext,
  connectionId: string,
): Promise<RefreshCapabilitiesResult> => {
  const { instance } = await loadConnection(ctx, connectionId)
  if (!(await canManageAppConnectionScope(ctx, instance.scopeType, instance.scopeId))) {
    forbidden('You do not have permission to manage this connected account')
  }
  const refreshed = await refreshInstance(
    ctx.prisma,
    ctx.actorContext.tenant.organizationId,
    connectionId,
    {
      probeUserId: ctx.actorContext.actor.actorId,
      secretResolver: ctx.secretResolver,
      managerFactory: ctx.managerFactory,
    },
  )
  await captureConnectionCapabilities(ctx, refreshed)
  const tools = refreshed.discoveredTools
  return {
    connectionId,
    status: deriveConnectionStatus(refreshed.lifecycleState),
    toolCount: Array.isArray(tools) ? tools.length : 0,
  }
}

/**
 * Disconnect requires the scope's manage right rather than mere reach: taking a
 * shared connected account away affects everyone it reaches, which "I can sign
 * in to this" should not authorise.
 */
export const disconnectAppConnection = async (
  ctx: AppConnectContext,
  connectionId: string,
): Promise<DisconnectedApp> => {
  const organizationId = ctx.actorContext.tenant.organizationId
  const instance = await getInstance(ctx.prisma, organizationId, connectionId)
  if (!instance) connectionNotFound()
  if (!(await canManageAppConnectionScope(ctx, instance.scopeType, instance.scopeId))) {
    forbidden('You do not have permission to disconnect this account')
  }
  await deleteInstance(ctx.prisma, organizationId, connectionId)
  return {
    connectionId,
    catalogEntryId: instance.catalogEntryId,
    scopeType: instance.scopeType,
    scopeId: instance.scopeId,
  }
}
