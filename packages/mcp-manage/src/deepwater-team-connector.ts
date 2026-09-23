import type { Prisma, PrismaClient } from '@prisma/client'

import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

type DeepWaterDb = PrismaClient | Prisma.TransactionClient

/** The DeepWater tool names the current manifest projects, in manifest order. */
export const deepWaterManifestToolNames = (): string[] =>
  getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)?.mcp?.tools.map((tool) => tool.name) ?? []

/**
 * Is a team instance's projected tool contract the current manifest's? Names
 * are the contract: a probed adapter may carry richer schemas, but a team whose
 * names differ is on an older (or a legacy direct-provider) contract and must
 * be upgraded before anything new is started through it.
 */
export const isCurrentDeepWaterToolContract = (discoveredTools: unknown): boolean => {
  if (!Array.isArray(discoveredTools)) return false
  const discovered = discoveredTools
    .map((tool) =>
      tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
        ? (tool as { name: string }).name
        : null)
    .filter((name): name is string => name !== null)
    .sort()
  const current = deepWaterManifestToolNames().sort()
  return discovered.length === current.length
    && discovered.every((name, index) => name === current[index])
}

/**
 * Why a team cannot start DeepWater work right now, in the vocabulary of the
 * brief API's `DEEP_WATER_NOT_READY` reasons.
 */
export type DeepWaterTeamConnectorState =
  | { state: 'ready'; instanceId: string }
  | { state: 'team_off' }
  | { state: 'contract_outdated'; instanceId: string }
  | { state: 'unavailable' }

/**
 * Read the team's DeepWater switch and its active first-party connector. Call
 * it inside `runWithDeepWaterTransitionLock` when the answer gates a write, so
 * a concurrent disable or contract upgrade is serialised against that write.
 */
export const readDeepWaterTeamConnector = async (
  db: DeepWaterDb,
  input: { organizationId: string; teamId: string },
): Promise<DeepWaterTeamConnectorState> => {
  const enablement = await db.productTeamEnablement.findUnique({
    where: {
      organizationId_teamId_productSlug: {
        organizationId: input.organizationId,
        productSlug: DEEP_WATER_PRODUCT_SLUG,
        teamId: input.teamId,
      },
    },
    select: { enabled: true },
  })
  if (!enablement?.enabled) return { state: 'team_off' }

  const instance = await db.mcpServerInstance.findFirst({
    where: {
      organizationId: input.organizationId,
      scopeId: input.teamId,
      scopeType: 'team',
      lifecycleState: 'active',
      catalogEntry: {
        name: DEEP_WATER_PRODUCT_SLUG,
        organizationId: null,
        visibility: 'public',
        integratedProducts: { some: { slug: DEEP_WATER_PRODUCT_SLUG } },
      },
    },
    select: { id: true, discoveredTools: true },
  })
  if (!instance) return { state: 'unavailable' }
  if (!isCurrentDeepWaterToolContract(instance.discoveredTools)) {
    return { state: 'contract_outdated', instanceId: instance.id }
  }
  return { state: 'ready', instanceId: instance.id }
}

/**
 * The registry entry an agent's policy must grant for `toolName` on this
 * team's connector: the projected, active, explicit-grant row. Null when the
 * connector does not project it.
 */
export const findDeepWaterToolPolicyKey = async (
  db: DeepWaterDb,
  input: { organizationId: string; instanceId: string; toolName: string },
): Promise<string | null> => {
  const entries = await db.toolRegistryEntry.findMany({
    where: {
      organizationId: input.organizationId,
      mcpInstanceId: input.instanceId,
      enabled: true,
      status: 'active',
    },
    select: { id: true, metadata: true, transportConfig: true },
  })
  const matches = entries.filter((entry) => {
    const metadata = entry.metadata as { requiresExplicitGrant?: unknown } | null
    const transport = entry.transportConfig as { toolName?: unknown } | null
    return metadata?.requiresExplicitGrant === true && transport?.toolName === input.toolName
  })
  // Two projected rows for one tool name is a broken projection, not a choice.
  const [only] = matches
  return matches.length === 1 && only ? only.id : null
}
