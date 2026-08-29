import { McpClientManager, McpError } from '@nessie/mcp-client'
import type { McpConnectionId, McpToolDescriptor } from '@nessie/mcp-client'
import type { AuthorizedActionContext, McpTransportConfig } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { getCatalogEntry } from '../mcp-catalog.js'
import { resolveCredentialRef } from '../mcp-credentials.js'
import {
  resolveProbeTransport,
  transportToConnectionSpec,
  type ManagerFactory,
} from '../mcp-instance-probe.js'
import type { McpInstanceRow } from '../mcp-instances.js'
import { assertMcpTransportSafe } from '../mcp-security.js'
import type { SecretResolver } from '../secret-resolver.js'

import { recordAppHealth } from './app-health.js'

/**
 * Capability discovery for the App Store — "what did I get?" as a member's
 * detail page asks it: capabilities, resources, prompts.
 *
 * `probeConnection` (`mcp-instance-probe.ts`) answers one narrower question —
 * did `tools/list` work — and its contract is pinned by the Connectors page,
 * the PA `connector_*` tools and DeepWater activation. It is left byte-
 * identical. This is a SECOND READ over the same seams (`assertMcpTransportSafe`,
 * `transportToConnectionSpec`, `ManagerFactory`, one `McpClientManager`), never
 * a second transport: it exists as its own function only because it must keep
 * the connection open while two further listings run on it, which the probe's
 * open-list-close shape cannot do.
 *
 * Discovery is READ-ONLY. It lists what a server offers; it never calls a
 * tool. Asking an app what it can do must not be able to make it do anything.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/ux-design-detail-and-connect.md`
 * §1 (capability count strip) and §3 ("Refresh capabilities").
 */

/**
 * What the server said about itself in its `initialize` response.
 *
 * This is the whole reason resource and prompt discovery is gated rather than
 * attempted: `resources/list` against a server that never advertised
 * `resources` is a method the server does not implement, and the well-behaved
 * answer is a JSON-RPC error. Discovering capabilities must not be the thing
 * that turns a healthy app into an errored one on its own store card.
 */
export type AdvertisedCapabilities = {
  resources: boolean
  prompts: boolean
}

/**
 * The two listings beyond `tools/list` that a capability read needs from an
 * already-open connection, plus the handshake advertisement that decides
 * whether either may be sent.
 *
 * A seam rather than a direct call so the gate stays testable offline: the
 * factory is handed the live connection, and a caller that cannot answer these
 * questions returns `null`, leaving both counts `null` ("not determined")
 * rather than guessed.
 */
export type McpCapabilityListing = {
  advertised: AdvertisedCapabilities
  listResources: () => Promise<readonly unknown[]>
  listPrompts: () => Promise<readonly unknown[]>
}

/** Built per connection, from the connection's own two handles. */
export type CapabilityListingFactory = (
  manager: McpClientManager,
  connectionId: McpConnectionId,
) => McpCapabilityListing | null

/**
 * The real adapter, over `@nessie/mcp-client`'s own listings.
 *
 * It reads the advertisement from the handshake the connection already
 * completed, so an unadvertised listing is answered without a request — never
 * sent and refused. A server that advertised nothing at all yields `null`,
 * which keeps "we could not ask" distinct from "there are none".
 */
export const defaultCapabilityListing: CapabilityListingFactory = (
  manager,
  connectionId,
) => {
  const advertised = manager.serverCapabilities(connectionId)
  if (!advertised) return null
  return {
    advertised: { resources: advertised.resources, prompts: advertised.prompts },
    listResources: () => manager.listResources(connectionId),
    listPrompts: () => manager.listPrompts(connectionId),
  }
}

export type CapabilityDiscoveryOptions = {
  managerFactory?: ManagerFactory
  /**
   * Defaults to the real listing adapter, so no production caller can silently
   * discover tools and nothing else. Pass one that returns `null` to read tools
   * alone.
   */
  capabilityListing?: CapabilityListingFactory
}

/**
 * One discovery attempt.
 *
 * Every count is `number | null`, and the distinction is load-bearing: `0` is a
 * claim ("this server has no prompts", learned from its own handshake) while
 * `null` is an absence of knowledge. Collapsing them would let one failed
 * attempt overwrite a good cached count with a confident zero.
 */
export type AppCapabilityDiscovery = {
  /** The server answered at all — see `reachedServer`. */
  reachable: boolean
  /** The MCP `initialize` handshake completed. */
  initializationSuccessful: boolean
  latencyMs: number
  toolCount: number | null
  resourceCount: number | null
  promptCount: number | null
  /** Present only on a clean `tools/list`; the caller projects these. */
  descriptors: McpToolDescriptor[] | null
  error: string | null
}

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * `reachable` means "the server answered", not "the handshake worked".
 *
 * The client classifies its throws (`McpError.kind`), and only a server that
 * replied can produce a PROTOCOL or AUTH failure — a 401 is an answer. TRANSPORT
 * and TIMEOUT mean nothing was reached, and the SSRF guard throws a plain
 * `McpSecurityError` before we dial at all. Collapsing the two would make
 * "Unavailable" on a card mean "unreachable OR refused your credentials", which
 * are different problems with different next actions.
 */
const reachedServer = (error: unknown): boolean =>
  error instanceof McpError && (error.kind === 'PROTOCOL' || error.kind === 'AUTH')

const countAdvertisedListing = async (
  advertised: boolean,
  list: () => Promise<readonly unknown[]>,
): Promise<number | null> => {
  // Not advertised is not "unknown" — the server itself said it has none.
  // Answered from the handshake, never by sending the request anyway.
  if (!advertised) return 0
  try {
    const entries = await list()
    return Array.isArray(entries) ? entries.length : null
  } catch {
    // The server advertised these and then would not list them. Tools already
    // succeeded, so this is recorded as undetermined rather than failing an
    // otherwise working discovery over a secondary count.
    return null
  }
}

const failedBeforeHandshake = (
  error: unknown,
  latencyMs: number,
): AppCapabilityDiscovery => ({
  reachable: reachedServer(error),
  initializationSuccessful: false,
  latencyMs,
  toolCount: null,
  resourceCount: null,
  promptCount: null,
  descriptors: null,
  error: stringifyError(error),
})

const failedAfterHandshake = (
  error: string,
  latencyMs: number,
): AppCapabilityDiscovery => ({
  reachable: true,
  initializationSuccessful: true,
  latencyMs,
  toolCount: null,
  resourceCount: null,
  promptCount: null,
  descriptors: null,
  error,
})

/**
 * Open one connection, read what the app offers, close it.
 *
 * Failure is always a returned result, never a throw: a card that cannot say
 * "42 capabilities" still has to render, and the caller decides what an
 * unreachable app means for the flow it is in.
 */
export const discoverAppCapabilities = async (
  transport: McpTransportConfig,
  options: CapabilityDiscoveryOptions = {},
): Promise<AppCapabilityDiscovery> => {
  const manager = (options.managerFactory ?? (() => new McpClientManager()))()
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt

  let connectionId: McpConnectionId
  try {
    await assertMcpTransportSafe(transport)
    connectionId = await manager.open(transportToConnectionSpec(transport))
  } catch (error) {
    await manager.closeAll().catch(() => undefined)
    return failedBeforeHandshake(error, elapsed())
  }

  // `manager.open()` resolving means the MCP `initialize` handshake completed,
  // so everything below is a failure of a specific read, not of the connection.
  try {
    const descriptors = await manager.listTools(connectionId)
    if (!Array.isArray(descriptors)) {
      return failedAfterHandshake('tools/list response was not an array', elapsed())
    }
    const buildListing = options.capabilityListing ?? defaultCapabilityListing
    const listing = buildListing(manager, connectionId)
    const [resourceCount, promptCount] = listing
      ? await Promise.all([
        countAdvertisedListing(listing.advertised.resources, () => listing.listResources()),
        countAdvertisedListing(listing.advertised.prompts, () => listing.listPrompts()),
      ])
      : [null, null]
    return {
      reachable: true,
      initializationSuccessful: true,
      latencyMs: elapsed(),
      toolCount: descriptors.length,
      resourceCount,
      promptCount,
      descriptors,
      error: null,
    }
  } catch (error) {
    return failedAfterHandshake(stringifyError(error), elapsed())
  } finally {
    await manager.close(connectionId).catch(() => undefined)
    await manager.closeAll().catch(() => undefined)
  }
}

/**
 * Persist one discovery: always the health side table, and the catalogue row's
 * cached counts only when there is something new to cache.
 *
 * The two writes are separate on purpose. `mcp_server_health` is a side table
 * precisely so health can never slow or fail a catalogue read (see
 * `app-health.ts`); the counts on `mcp_catalog_entries` are what lets a card
 * say "42 capabilities" without probing anything.
 */
export const persistAppCapabilities = async (
  prisma: PrismaClient,
  catalogEntryId: string,
  discovery: AppCapabilityDiscovery,
  checkedAt: Date = new Date(),
): Promise<void> => {
  await recordAppHealth(prisma, catalogEntryId, discovery, checkedAt)

  // The catalogue row caches what was last LEARNED. A failed attempt learns
  // nothing, so it must not blank a good count — recording the failure is the
  // health row's whole job, and blanking here would empty the store's cards
  // every time an app had a bad minute.
  if (!discovery.initializationSuccessful || discovery.toolCount === null) return

  await prisma.mcpCatalogEntry.update({
    where: { id: catalogEntryId },
    data: {
      toolCount: discovery.toolCount,
      // An undetermined count leaves the column untouched, so a run with no
      // listing adapter cannot erase what a better-equipped one wrote.
      ...(discovery.resourceCount === null ? {} : { resourceCount: discovery.resourceCount }),
      ...(discovery.promptCount === null ? {} : { promptCount: discovery.promptCount }),
      capabilitiesAt: checkedAt,
    },
  })
}

/**
 * What a capability read needs from the flow that triggered it, and nothing
 * else. Deliberately a structural subset of the connect flow's own context, so
 * a caller hands over what it already holds and this module never has to know
 * what a connect is. The credential is read as the acting user, exactly as
 * `testInstance`'s probe does.
 */
export type ConnectionCapabilityContext = {
  prisma: PrismaClient
  actorContext: AuthorizedActionContext
  secretResolver?: SecretResolver
  managerFactory?: ManagerFactory
}

/**
 * Discover one connection's capabilities and persist them against its app.
 *
 * This is the call site that makes the columns real. Without it
 * `toolCount`/`resourceCount`/`promptCount`/`capabilitiesAt` are never written
 * — so the detail page's Resources and Prompts tiles can never render — and
 * `mcp_server_health` stays empty, which is the one table
 * `loadUnreachableAppIds` reads to mark a dead server unavailable.
 *
 * It costs a second dial. `testInstance`'s probe cannot be reused for it: that
 * contract is pinned by the Connectors page, the PA `connector_*` tools and
 * DeepWater activation, and it closes its connection before resources or
 * prompts could be asked for.
 *
 * Never throws. A connect that worked must not fail because a card could not
 * cache a number, and a server that cannot be reached is exactly what the
 * health row exists to record — so the failure is the result, not an exception.
 */
export const captureConnectionCapabilities = async (
  ctx: ConnectionCapabilityContext,
  instance: McpInstanceRow,
): Promise<AppCapabilityDiscovery | null> => {
  const organizationId = ctx.actorContext.tenant.organizationId
  try {
    const entry = await getCatalogEntry(ctx.prisma, organizationId, instance.catalogEntryId)
    if (!entry) return null
    const credentialRef = await resolveCredentialRef(ctx.prisma, instance.id, {
      userId: ctx.actorContext.actor.actorId,
      organizationId,
    })
    const transport = await resolveProbeTransport(
      { ...instance, credentialRef },
      entry,
      ctx.secretResolver,
    )
    const discovery = await discoverAppCapabilities(transport, {
      managerFactory: ctx.managerFactory,
    })
    await persistAppCapabilities(ctx.prisma, instance.catalogEntryId, discovery)
    return discovery
  } catch {
    // Credential resolution, transport assembly and the two writes are the only
    // things that can throw here, and none of them is the caller's business:
    // this is telemetry beside the action, never the action itself.
    return null
  }
}
