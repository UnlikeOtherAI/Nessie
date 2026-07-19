import { Prisma, type PrismaClient } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  createInstance,
  projectMcpToolDescriptors,
  type McpInstanceRow,
} from '@nessie/mcp-manage'
import { loadLedgerIdentitySettings } from '@nessie/runtime'

import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'
import { setProductTeamEnablement } from './integrations.js'

/**
 * DeepWater team activation.
 *
 * Enabling DeepWater for a team provisions a TEAM-scoped, tool-projecting
 * `McpServerInstance` so the `research_*` tools land in `ToolRegistryEntry`
 * (surfaced to agent runs as `mcp_research_*`). A team-scoped connector reaches
 * every agent run inside the team, but the projected DeepWater rows are flagged
 * `requiresExplicitGrant` — so they are OFF for every agent (personal assistant
 * and shared alike) by default and surface ONLY to an agent whose per-agent
 * tool policy carries an explicit allow (`toolPolicy[registryEntryId] === true`;
 * see `worker/src/run/mcp-toolset.ts`). "Any agent can use DeepWater only as
 * long as it allows it": exposure requires an explicit grant, never scope alone.
 *
 * DeepWater traffic goes through Ledger's first-party MCP adapter. The shared
 * tool contract is the plugin manifest (`integration-plugin-manifests.ts`), not
 * a live provider probe. Enable is therefore a deterministic provision: resolve
 * the Ledger MCP endpoint from the manifest and install a bearer-authenticated
 * HTTP transport authenticated by Nessie's dedicated, product-bound Ledger app
 * API key. The originating SSO user and Nessie org/team/agent/run are sent
 * independently as signed per-call identity headers, so transport
 * authentication cannot collapse ownership or spend attribution. Ledger owns
 * the upstream provider credential, job budget, and immutable booked rate-card
 * charge.
 */

export const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
type DeepWaterDb = PrismaClient | Prisma.TransactionClient
type DeepWaterScope = { organizationId: string; teamId: string }

/**
 * Raised when DeepWater is enabled but the Ledger MCP endpoint env var is
 * unset. We fail loudly rather than create a dead instance whose tools silently
 * drop; the enable route maps this to a
 * `LEDGER_DEEPWATER_MCP_URL_UNSET` API error.
 */
export class LedgerDeepWaterMcpUrlUnsetError extends Error {
  readonly code = 'LEDGER_DEEPWATER_MCP_URL_UNSET'

  constructor(public readonly envVar: string) {
    super(
      `Ledger DeepWater MCP endpoint is not configured: set ${envVar} to Ledger's `
      + 'DeepWater MCP adapter URL before enabling DeepWater for a team.',
    )
    this.name = 'LedgerDeepWaterMcpUrlUnsetError'
  }
}

export class LedgerDeepWaterCatalogUnavailableError extends Error {
  readonly code = 'LEDGER_DEEPWATER_CATALOG_UNAVAILABLE'

  constructor() {
    super(
      'The first-party public DeepWater catalog entry is not linked and published. '
      + 'Repair the integration catalog before enabling DeepWater.',
    )
    this.name = 'LedgerDeepWaterCatalogUnavailableError'
  }
}

export class LedgerAppApiKeyUnsetError extends Error {
  readonly code = 'LEDGER_PROXY_TOKEN_UNSET'

  constructor() {
    super(
      'Nessie\'s product-bound Ledger app API key is not configured: set '
      + 'LEDGER_PROXY_TOKEN before enabling DeepWater.',
    )
    this.name = 'LedgerAppApiKeyUnsetError'
  }
}

export class LedgerIdentityConfigurationUnsetError extends Error {
  readonly code = 'LEDGER_IDENTITY_UNCONFIGURED'

  constructor() {
    super(
      'Signed Ledger caller identity is not configured. Complete the UOA domain, '
      + 'config URL, signing key, key id, and client secret settings first.',
    )
    this.name = 'LedgerIdentityConfigurationUnsetError'
  }
}

export class LedgerDeepWaterEnablementPersistenceError extends Error {
  readonly code = 'LEDGER_DEEPWATER_ENABLEMENT_NOT_PERSISTED'

  constructor() {
    super('DeepWater enablement could not be persisted for this team.')
    this.name = 'LedgerDeepWaterEnablementPersistenceError'
  }
}

export class LedgerDeepWaterActiveRunsError extends Error {
  readonly code = 'LEDGER_DEEPWATER_ACTIVE_RUNS'

  constructor(public readonly run: {
    channelId: string | null
    externalRunId: string | null
    id: string
    status: string
  }) {
    super(
      `Deep Water run ${run.id} is still ${run.status}`
      + (run.channelId
        ? `; open /channels/${run.channelId}, ask the Personal Assistant to call research_cancel, and retry after the run becomes terminal.`
        : '; it has no attached chat, so the connector is retained until an explicit run recovery is performed.'),
    )
    this.name = 'LedgerDeepWaterActiveRunsError'
  }
}

const LEDGER_DEEP_WATER_URL_ENV = 'LEDGER_DEEPWATER_MCP_URL'
export const NESSIE_LEDGER_APP_API_KEY_ENV = 'LEDGER_PROXY_TOKEN'

/** Environment variable name declared by the DeepWater manifest transport. */
const deepWaterTransportUrlEnv = (): string => {
  const manifest = getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)
  const transport = manifest?.mcp?.catalogTemplate?.transport as
    | { urlEnv?: unknown }
    | undefined
  return typeof transport?.urlEnv === 'string' && transport.urlEnv.length > 0
    ? transport.urlEnv
    : LEDGER_DEEP_WATER_URL_ENV
}

/**
 * Resolve the Ledger MCP endpoint. There is deliberately no direct-provider
 * fallback: an unset Ledger endpoint makes team enablement fail closed.
 */
const resolveDeepWaterLedgerUrl = (): string => {
  const envVar = deepWaterTransportUrlEnv()
  const url = process.env[envVar]?.trim()
  if (!url) {
    throw new LedgerDeepWaterMcpUrlUnsetError(envVar)
  }
  return url
}

const assertLedgerConnectionConfigured = (): void => {
  if (!process.env[NESSIE_LEDGER_APP_API_KEY_ENV]?.trim()) {
    throw new LedgerAppApiKeyUnsetError()
  }
  if (!loadLedgerIdentitySettings()) {
    throw new LedgerIdentityConfigurationUnsetError()
  }
}

const deepWaterTransitionLockKey = (input: DeepWaterScope): string =>
  `${input.organizationId}:${input.teamId}:${DEEP_WATER_PRODUCT_SLUG}`

/**
 * PostgreSQL transaction-scoped advisory locking serializes opposite
 * enable/disable requests across API processes. All transition reads and writes
 * use the locked transaction client, so the lock does not rely on process-local
 * memory and cannot be bypassed by a second Nessie replica.
 */
export const runWithDeepWaterTransitionLock = <T>(
  prisma: PrismaClient,
  input: DeepWaterScope,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${deepWaterTransitionLockKey(input)}, 0)
      )
    `)
    return action(tx)
  })

const loadPublishedCatalogEntryId = async (
  prisma: DeepWaterDb,
): Promise<string | null> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: {
      name: DEEP_WATER_PRODUCT_SLUG,
      organizationId: null,
      visibility: 'public',
      status: 'published',
      integratedProducts: { some: { slug: DEEP_WATER_PRODUCT_SLUG } },
    },
    select: { id: true },
  })
  return entry?.id ?? null
}

const manifestToolDescriptors = (): McpToolDescriptor[] => {
  const manifest = getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)
  const tools = manifest?.mcp?.tools ?? []
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.label,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
  }))
}

const findTeamInstance = async (
  prisma: DeepWaterDb,
  input: { organizationId: string; teamId: string; catalogEntryId: string },
): Promise<McpInstanceRow | null> =>
  prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: input.organizationId,
      catalogEntryId: input.catalogEntryId,
      scopeType: 'team',
      scopeId: input.teamId,
    },
  })

/**
 * A previously probed Ledger adapter may carry richer schemas than the
 * deterministic manifest. Preserve those schemas only when its tool-name set
 * exactly matches the current Ledger contract. Legacy direct-provider contracts
 * are replaced so old tools can never be dispatched to the Ledger endpoint.
 */
const hasCurrentLedgerToolContract = (
  instance: McpInstanceRow,
  descriptors: McpToolDescriptor[],
): boolean => {
  if (!Array.isArray(instance.discoveredTools)) return false
  const discoveredNames = instance.discoveredTools
    .map((tool) =>
      tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
        ? (tool as { name: string }).name
        : null)
    .filter((name): name is string => name !== null)
    .sort()
  const manifestNames = descriptors.map((descriptor) => descriptor.name).sort()
  return discoveredNames.length === manifestNames.length
    && discoveredNames.every((name, index) => name === manifestNames[index])
}

/**
 * Idempotently ensure a team-scoped DeepWater instance whose manifest tools are
 * projected, `active`, and flagged `requiresExplicitGrant`. Missing first-party
 * catalog linkage and a missing Ledger endpoint both fail loudly; enablement is
 * never persisted without a callable connector.
 */
const ensureDeepWaterTeamInstanceInTransaction = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  input: DeepWaterScope,
): Promise<McpInstanceRow> => {
  const catalogEntryId = await loadPublishedCatalogEntryId(tx)
  if (!catalogEntryId) {
    throw new LedgerDeepWaterCatalogUnavailableError()
  }

  const ledgerUrl = resolveDeepWaterLedgerUrl()
  assertLedgerConnectionConfigured()
  const existing = await findTeamInstance(tx, { ...input, catalogEntryId })

  let instance = existing
  if (!instance) {
    // createInstance performs the normal catalog, scope, lock, and SSRF checks.
    // The cast is structural: Prisma TransactionClient exposes every delegate
    // used by that service, while intentionally omitting connection lifecycle.
    instance = await createInstance(tx as unknown as PrismaClient, actorContext, {
      catalogEntryId,
      credentialRef: NESSIE_LEDGER_APP_API_KEY_ENV,
      managedProvision: true,
      scopeType: 'team',
      scopeId: input.teamId,
      transportConfig: { transport: 'http', url: ledgerUrl },
    })
  }

  const provisioned = instance
  const descriptors = manifestToolDescriptors()
  const preserveProbedSchemas =
    Boolean(existing) && hasCurrentLedgerToolContract(provisioned, descriptors)

  if (preserveProbedSchemas) {
    // Keep a current Ledger adapter's richer discovered schemas, but always
    // enforce the configured Ledger endpoint and Nessie's product-bound app key.
    await tx.mcpServerInstance.update({
      where: { id: provisioned.id },
      data: {
        credentialRef: NESSIE_LEDGER_APP_API_KEY_ENV,
        transportConfig: { transport: 'http', url: ledgerUrl },
        lifecycleState: 'active',
        healthFailureCount: 0,
        // Active here means the deterministic Ledger contract is projected.
        healthLastCheckedAt: null,
        lastError: null,
      },
    })
  } else {
    // First provision or legacy direct-provider contract: replace every old
    // projection before installing Ledger's deterministic tool contract.
    // Registry ids intentionally change, so explicit grants must be renewed
    // for the new tools instead of silently inheriting authority.
    await tx.toolRegistryEntry.deleteMany({
      where: { mcpInstanceId: provisioned.id },
    })
    await tx.mcpServerInstance.update({
      where: { id: provisioned.id },
      data: {
        credentialRef: NESSIE_LEDGER_APP_API_KEY_ENV,
        transportConfig: { transport: 'http', url: ledgerUrl },
        discoveredTools: descriptors as unknown as object,
        lifecycleState: 'active',
        healthFailureCount: 0,
        healthLastCheckedAt: null,
        lastError: null,
      },
    })
    await projectMcpToolDescriptors(tx, {
      organizationId: input.organizationId,
      instance: { id: provisioned.id, scopeType: 'team', scopeId: input.teamId },
      descriptors,
    })
  }
  // First-party team-enable is the review: flip the projected (shared-scope,
  // so `pending_review` by default) tools to `active` and flag them
  // `requiresExplicitGrant` so exposure needs an explicit per-agent allow.
  await tx.toolRegistryEntry.updateMany({
    where: { mcpInstanceId: provisioned.id },
    data: { status: 'active', metadata: { requiresExplicitGrant: true } },
  })
  return tx.mcpServerInstance.findUniqueOrThrow({ where: { id: provisioned.id } })
}

export const ensureDeepWaterTeamInstance = (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: DeepWaterScope,
): Promise<McpInstanceRow> =>
  runWithDeepWaterTransitionLock(prisma, input, (tx) =>
    ensureDeepWaterTeamInstanceInTransaction(tx, actorContext, input))

/**
 * Remove the team-scoped DeepWater instance and its projected tools when a team
 * disables DeepWater. Idempotent — a no-op when nothing is installed. Teardown
 * is keyed on the public catalog entry linked from the first-party integrated
 * product (not a name collision), so a renamed/unpublished catalog entry can
 * never leave an active instance + tool rows exposing research after disable,
 * while a private user-authored connector named `deep-water` is never selected.
 */
const removeDeepWaterTeamInstanceInTransaction = async (
  tx: Prisma.TransactionClient,
  input: DeepWaterScope,
): Promise<{ instanceId: string | null }> => {
  const instance = await tx.mcpServerInstance.findFirst({
    where: {
      organizationId: input.organizationId,
      scopeType: 'team',
      scopeId: input.teamId,
      catalogEntry: {
        visibility: 'public',
        integratedProducts: { some: { slug: DEEP_WATER_PRODUCT_SLUG } },
      },
    },
    select: { id: true },
  })
  if (!instance) return { instanceId: null }

  const activeRun = await tx.productIntegrationRun.findFirst({
    where: {
      connectorId: instance.id,
      organizationId: input.organizationId,
      productSlug: DEEP_WATER_PRODUCT_SLUG,
      status: { in: ['queued', 'running', 'needs_setup'] },
      teamId: input.teamId,
    },
    select: {
      channelId: true,
      externalRunId: true,
      id: true,
      status: true,
    },
  })
  if (activeRun) {
    throw new LedgerDeepWaterActiveRunsError(activeRun)
  }

  await tx.toolRegistryEntry.deleteMany({ where: { mcpInstanceId: instance.id } })
  await tx.mcpServerInstance.delete({ where: { id: instance.id } })
  return { instanceId: instance.id }
}

export const removeDeepWaterTeamInstance = (
  prisma: PrismaClient,
  input: DeepWaterScope,
): Promise<{ instanceId: string | null }> =>
  runWithDeepWaterTransitionLock(prisma, input, (tx) =>
    removeDeepWaterTeamInstanceInTransaction(tx, input))

/**
 * Apply the connector side before its matching product flag. The caller runs
 * this inside one serialized database transaction, so any effect or persistence
 * error rolls the entire transition back.
 */
type DeepWaterEnablementEffects<T> = {
  persist: () => Promise<T | null>
  provision: () => Promise<void>
  teardown: () => Promise<void>
}

export const runDeepWaterEnablementTransition = async <T>(
  enabled: boolean,
  effects: DeepWaterEnablementEffects<T>,
): Promise<T | null> => {
  if (enabled) await effects.provision()
  else await effects.teardown()
  return effects.persist()
}

export const setDeepWaterTeamEnablement = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    enabled: boolean
    organizationId: string
    teamId: string
    userId: string
  },
): Promise<NonNullable<Awaited<ReturnType<typeof setProductTeamEnablement>>>> =>
  runWithDeepWaterTransitionLock(prisma, input, async (tx) => {
    const persisted = await runDeepWaterEnablementTransition(input.enabled, {
      provision: async () => {
        await ensureDeepWaterTeamInstanceInTransaction(tx, actorContext, input)
      },
      teardown: async () => {
        await removeDeepWaterTeamInstanceInTransaction(tx, input)
      },
      persist: () => setProductTeamEnablement(tx, {
        enabled: input.enabled,
        organizationId: input.organizationId,
        productSlug: DEEP_WATER_PRODUCT_SLUG,
        teamId: input.teamId,
        userId: input.userId,
      }),
    })
    if (!persisted) {
      throw new LedgerDeepWaterEnablementPersistenceError()
    }
    return persisted
  })
