import type { PrismaClient } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  createInstance,
  projectMcpToolDescriptors,
  type McpInstanceRow,
} from '@nessie/mcp-manage'

import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'

/**
 * DeepWater team activation.
 *
 * Enabling DeepWater for a team provisions a TEAM-scoped, tool-projecting
 * `McpServerInstance` so the `research_*` tools land in `ToolRegistryEntry`
 * (surfaced to agent runs as `mcp_research_*`). A team-scoped connector reaches
 * EVERY agent run inside the team — personal assistant and shared agents alike
 * (see `worker/src/run/mcp-toolset.ts` `scopeMatchesRun`) — so any permitted
 * agent can be granted the DeepWater tools through its per-agent tool policy.
 *
 * DeepWater is OAuth2 + first-party hosted: the shared MCP tool contract is the
 * plugin manifest (`integration-plugin-manifests.ts`), not a live per-user
 * network probe, and each user still authorises DeepWater with their own token
 * at dispatch. Enable is therefore a deterministic provision — we project the
 * manifest's declared tools and mark the instance + its projected tools
 * `active` (the owner's explicit team-enable IS the admin review that shared
 * scopes otherwise defer as `pending_review`). Per-agent grant stays OFF by
 * default; that per-agent grant is the "allow this agent" gate, not exposure.
 */

export const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

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
 * Idempotently ensure a team-scoped DeepWater instance whose manifest tools are
 * projected and `active`. Returns the instance, or null when the DeepWater
 * catalog entry is absent (a self-hosted instance that never seeded it).
 */
export const ensureDeepWaterTeamInstance = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { organizationId: string; teamId: string },
): Promise<McpInstanceRow | null> => {
  const catalogEntryId = await loadPublishedCatalogEntryId(prisma)
  if (!catalogEntryId) return null

  const existing = await findTeamInstance(prisma, { ...input, catalogEntryId })
  const instance =
    existing
    ?? (await createInstance(prisma, actorContext, {
      catalogEntryId,
      scopeType: 'team',
      scopeId: input.teamId,
    }))

  const descriptors = manifestToolDescriptors()
  return prisma.$transaction(async (tx) => {
    const updated = await tx.mcpServerInstance.update({
      where: { id: instance.id },
      data: {
        discoveredTools: descriptors as unknown as object,
        lifecycleState: 'active',
        healthFailureCount: 0,
        healthLastCheckedAt: new Date(),
        lastError: null,
      },
    })
    await projectMcpToolDescriptors(tx, {
      organizationId: input.organizationId,
      instance: { id: instance.id, scopeType: 'team', scopeId: input.teamId },
      descriptors,
    })
    // First-party team-enable is the review: flip the projected (shared-scope,
    // so `pending_review` by default) tools to `active` so they are grantable
    // to any agent. Grant itself stays default-off per agent.
    await tx.toolRegistryEntry.updateMany({
      where: { mcpInstanceId: instance.id },
      data: { status: 'active' },
    })
    return updated
  })
}

/**
 * Remove the team-scoped DeepWater instance and its projected tools when a team
 * disables DeepWater. Idempotent — a no-op when nothing is installed.
 */
export const removeDeepWaterTeamInstance = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string },
): Promise<{ instanceId: string | null }> => {
  const catalogEntryId = await loadPublishedCatalogEntryId(prisma)
  if (!catalogEntryId) return { instanceId: null }

  const instance = await findTeamInstance(prisma, { ...input, catalogEntryId })
  if (!instance) return { instanceId: null }

  await prisma.$transaction([
    prisma.toolRegistryEntry.deleteMany({ where: { mcpInstanceId: instance.id } }),
    prisma.mcpServerInstance.delete({ where: { id: instance.id } }),
  ])
  return { instanceId: instance.id }
}
