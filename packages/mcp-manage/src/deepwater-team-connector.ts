import type { Prisma, PrismaClient } from '@prisma/client'

import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'
import {
  DEEP_WATER_BRIEF_TOOL_NAMES,
  DEEP_WATER_LAUNCHER_TOOL_NAMES,
} from './integration-plugin-manifests/deep-water-brief-tools.js'

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

type DeepWaterDb = PrismaClient | Prisma.TransactionClient

/** The DeepWater tool names the current manifest projects, in manifest order. */
export const deepWaterManifestToolNames = (): string[] =>
  getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)?.mcp?.tools.map((tool) => tool.name) ?? []

const discoveredToolNames = (discoveredTools: unknown): string[] | null => {
  if (!Array.isArray(discoveredTools)) return null
  return discoveredTools
    .map((tool) =>
      tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
        ? (tool as { name: string }).name
        : null)
    .filter((name): name is string => name !== null)
}

const sameNameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((name, index) => name === b[index])
}

/**
 * Is a team instance's projected tool contract the current manifest's? Names
 * are the contract: a probed adapter may carry richer schemas, but a team whose
 * names differ is on an older (or a legacy direct-provider) contract and must
 * be upgraded before its agents' access is computed from the manifest.
 */
export const isCurrentDeepWaterToolContract = (discoveredTools: unknown): boolean => {
  const discovered = discoveredToolNames(discoveredTools)
  return discovered !== null && sameNameSet(discovered, deepWaterManifestToolNames())
}

/**
 * Does the instance project exactly the brief-first contract — the only one a
 * research brief can be agreed and launched through? The manifest projects it,
 * so a team whose connector does not is `contract_outdated` until its owner's
 * next enable upgrades it.
 */
export const projectsDeepWaterBriefContract = (discoveredTools: unknown): boolean => {
  const discovered = discoveredToolNames(discoveredTools)
  return discovered !== null && sameNameSet(discovered, DEEP_WATER_BRIEF_TOOL_NAMES)
}

const LEDGER_DEEP_WATER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DEEP_WATER_LAUNCHER_TOOL_NAMES,
  ...DEEP_WATER_BRIEF_TOOL_NAMES,
])

/**
 * Is this a contract Nessie projected from Ledger — the launcher contract, the
 * brief contract, or the current manifest's? Such a projection is upgraded in
 * place, keeping the registry ids (and so the grants) of the tools both
 * versions share. Anything else is the legacy direct-provider contract, which
 * is replaced outright and must be granted again.
 */
export const isLedgerDeepWaterToolContract = (discoveredTools: unknown): boolean => {
  const discovered = discoveredToolNames(discoveredTools)
  const current = new Set(deepWaterManifestToolNames())
  return discovered !== null
    && discovered.length > 0
    && discovered.every((name) => LEDGER_DEEP_WATER_TOOL_NAMES.has(name) || current.has(name))
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
 * Read the team's DeepWater switch and its active first-party connector, as a
 * research brief needs them: `ready` only when the connector projects the
 * brief contract. Call it inside `runWithDeepWaterTransitionLock` when the
 * answer gates a write, so a concurrent disable or contract upgrade is
 * serialised against that write.
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
  if (!projectsDeepWaterBriefContract(instance.discoveredTools)) {
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
