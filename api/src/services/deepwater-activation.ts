import type { PrismaClient } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  createInstance,
  projectMcpToolDescriptors,
  McpInstanceError,
  MCP_INSTANCE_ERROR_CODES,
  type McpInstanceRow,
} from '@nessie/mcp-manage'

import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'

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
 * DeepWater is OAuth2 + first-party hosted: the shared MCP tool contract is the
 * plugin manifest (`integration-plugin-manifests.ts`), not a live per-user
 * network probe, and each user still authorises DeepWater with their own token
 * at dispatch. Enable is therefore a deterministic provision — we resolve the
 * DeepWater MCP endpoint from the manifest's `urlEnv`, install the instance with
 * a usable HTTP transport, project the manifest's declared tools, and mark the
 * instance + its projected tools `active` (the owner's explicit team-enable IS
 * the admin review that shared scopes otherwise defer as `pending_review`).
 */

export const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

/**
 * Raised when DeepWater is enabled but the MCP endpoint env var is unset. We
 * fail loudly rather than create a dead instance whose tools silently drop; the
 * enable route maps this to a `DEEP_WATER_MCP_URL_UNSET` API error.
 */
export class DeepWaterMcpUrlUnsetError extends Error {
  readonly code = 'DEEP_WATER_MCP_URL_UNSET'

  constructor(public readonly envVar: string) {
    super(
      `DeepWater MCP endpoint is not configured: set ${envVar} to the DeepWater `
      + 'MCP server URL before enabling DeepWater for a team.',
    )
    this.name = 'DeepWaterMcpUrlUnsetError'
  }
}

const DEFAULT_DEEP_WATER_URL_ENV = 'DEEP_WATER_MCP_URL'

/** Env var name the manifest declares for the DeepWater MCP endpoint. */
const deepWaterUrlEnvVar = (): string => {
  const manifest = getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)
  const transport = manifest?.mcp?.catalogTemplate?.transport as
    | { urlEnv?: unknown }
    | undefined
  return typeof transport?.urlEnv === 'string' && transport.urlEnv.length > 0
    ? transport.urlEnv
    : DEFAULT_DEEP_WATER_URL_ENV
}

/**
 * Resolve the DeepWater MCP endpoint from the manifest-declared env var. Throws
 * {@link DeepWaterMcpUrlUnsetError} when unset so enable fails loudly instead of
 * provisioning an instance with no usable transport.
 */
const resolveDeepWaterMcpUrl = (): string => {
  const envVar = deepWaterUrlEnvVar()
  const url = process.env[envVar]?.trim()
  if (!url) {
    throw new DeepWaterMcpUrlUnsetError(envVar)
  }
  return url
}

const loadPublishedCatalogEntryId = async (
  prisma: PrismaClient,
): Promise<string | null> => {
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: { name: DEEP_WATER_PRODUCT_SLUG, visibility: 'public', status: 'published' },
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
    inputSchema: {},
  }))
}

const findTeamInstance = async (
  prisma: PrismaClient,
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
 * A real, manually-installed DeepWater instance has been probed: it carries
 * discovered tools or has advanced to `active`. Re-enabling one must NOT clobber
 * its probed schemas with manifest stubs — we only project stubs the first time
 * we create the instance.
 */
const isProbedInstall = (instance: McpInstanceRow): boolean =>
  instance.lifecycleState === 'active'
  || (Array.isArray(instance.discoveredTools) && instance.discoveredTools.length > 0)

/**
 * Idempotently ensure a team-scoped DeepWater instance whose manifest tools are
 * projected, `active`, and flagged `requiresExplicitGrant`. Returns the
 * instance, or null when the DeepWater catalog entry is absent (a self-hosted
 * instance that never seeded it). Throws {@link DeepWaterMcpUrlUnsetError} when
 * the DeepWater MCP endpoint env var is unset.
 */
export const ensureDeepWaterTeamInstance = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { organizationId: string; teamId: string },
): Promise<McpInstanceRow | null> => {
  const catalogEntryId = await loadPublishedCatalogEntryId(prisma)
  if (!catalogEntryId) {
    console.warn(
      `[deepwater] enable skipped for team ${input.teamId}: no published `
      + `"${DEEP_WATER_PRODUCT_SLUG}" catalog entry in org ${input.organizationId}`,
    )
    return null
  }

  const url = resolveDeepWaterMcpUrl()
  const existing = await findTeamInstance(prisma, { ...input, catalogEntryId })

  let instance = existing
  if (!instance) {
    try {
      instance = await createInstance(prisma, actorContext, {
        catalogEntryId,
        scopeType: 'team',
        scopeId: input.teamId,
        transportConfig: { transport: 'http', url },
      })
    } catch (error) {
      // Concurrent double-enable: the unique (catalogEntry, scope) constraint
      // fired between our lookup and create. Re-fetch the row the winner wrote.
      if (
        error instanceof McpInstanceError
        && error.code === MCP_INSTANCE_ERROR_CODES.DUPLICATE_SCOPE
      ) {
        instance = await findTeamInstance(prisma, { ...input, catalogEntryId })
      }
      if (!instance) throw error
    }
  }

  const provisioned = instance
  const probed = Boolean(existing) && isProbedInstall(provisioned)
  const descriptors = manifestToolDescriptors()

  return prisma.$transaction(async (tx) => {
    if (probed) {
      // Real probed install: keep its discovered schemas and endpoint intact.
      // Team-enable only (re)asserts the active lifecycle.
      await tx.mcpServerInstance.update({
        where: { id: provisioned.id },
        data: { lifecycleState: 'active' },
      })
    } else {
      // First provision (or a never-probed stub): install the resolved HTTP
      // transport and project the manifest's declared tools as stubs.
      await tx.mcpServerInstance.update({
        where: { id: provisioned.id },
        data: {
          transportConfig: { transport: 'http', url },
          discoveredTools: descriptors as unknown as object,
          lifecycleState: 'active',
          healthFailureCount: 0,
          healthLastCheckedAt: new Date(),
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
  })
}

/**
 * Remove the team-scoped DeepWater instance and its projected tools when a team
 * disables DeepWater. Idempotent — a no-op when nothing is installed. Teardown
 * is keyed on the instance's own catalog-entry NAME (not the currently-published
 * entry id), so a renamed/unpublished catalog entry can never leave an active
 * instance + tool rows exposing research after disable.
 */
export const removeDeepWaterTeamInstance = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string },
): Promise<{ instanceId: string | null }> => {
  const instance = await prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: input.organizationId,
      scopeType: 'team',
      scopeId: input.teamId,
      catalogEntry: { name: DEEP_WATER_PRODUCT_SLUG },
    },
    select: { id: true },
  })
  if (!instance) return { instanceId: null }

  await prisma.$transaction([
    prisma.toolRegistryEntry.deleteMany({ where: { mcpInstanceId: instance.id } }),
    prisma.mcpServerInstance.delete({ where: { id: instance.id } }),
  ])
  return { instanceId: instance.id }
}
