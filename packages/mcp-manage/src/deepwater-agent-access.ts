import type { Prisma, PrismaClient } from '@prisma/client'
import {
  DeepWaterAgentAccessResponseSchema,
  DeepWaterAgentAccessTargetSchema,
  type AgentToolPolicyTarget,
  type DeepWaterAgentAccessResponse,
  type DeepWaterAgentAccessTarget,
} from '@nessie/schemas'
import { ensureBuiltinToolsRegistered, listAgentToolPolicyTargets } from '@nessie/team-admin'
import {
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
  deepWaterBundleMarkerKey,
} from '@nessie/runtime'

import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'

/**
 * DeepWater agent access, read side: which registry entries make up a team's
 * bundle, whether its connector is on the contract access is computed for,
 * and what each agent holds. Granting and revoking live in
 * `deepwater-bundle-grants.ts`.
 */

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'

const REQUIRED_MCP_TOOL_NAMES =
  getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)?.mcp?.tools
    .map((tool) => tool.name) ?? []

export const DEEP_WATER_REQUIRED_TOOL_COUNT =
  REQUIRED_MCP_TOOL_NAMES.length + 1

export const DEEP_WATER_AGENT_ACCESS_ERROR_CODES = {
  ACTIVE_RUNS: 'DEEP_WATER_AGENT_ACCESS_ACTIVE_RUNS',
  AGENT_NOT_FOUND: 'DEEP_WATER_AGENT_NOT_FOUND',
  CONTRACT_OUTDATED: 'DEEP_WATER_CONTRACT_OUTDATED',
  TOOLS_UNAVAILABLE: 'DEEP_WATER_EXPLICIT_TOOLS_UNAVAILABLE',
} as const

export class DeepWaterAgentAccessError extends Error {
  override readonly name = 'DeepWaterAgentAccessError'

  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message)
  }
}

const objectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

export type DeepWaterPolicyKeys = {
  configured: boolean
  policyKeys: string[]
  revocationPolicyKeys: string[]
}

/**
 * A team's DeepWater access as its connector actually projects it.
 * `contractOutdated` means the connector projects another tool contract than
 * the one access is computed for (the manifest's, unless a contract upgrade
 * names its target): the bundle is never `configured` from it, and it is only
 * readable and revocable until an owner enables DeepWater again, which
 * upgrades it in place.
 */
export type DeepWaterTeamAccess = DeepWaterPolicyKeys & { contractOutdated: boolean }

const toolNameOf = (entry: { transportConfig: unknown }): string | null => {
  const toolName = objectRecord(entry.transportConfig).toolName
  return typeof toolName === 'string' ? toolName : null
}

const sameNameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((name, index) => name === b[index])
}

export const resolveDeepWaterPolicyKeys = (
  input: {
    builtinPolicyKey: string | null
    projectedEntries: Array<{
      id: string
      metadata: unknown
      transportConfig: unknown
    }>
    /** The contract's tool names; the manifest's unless an upgrade names its target. */
    requiredToolNames?: readonly string[]
  },
): DeepWaterPolicyKeys => {
  const requiredToolNames = input.requiredToolNames ?? REQUIRED_MCP_TOOL_NAMES
  const byToolName = new Map<string, string>()
  let exactProjectionSet = true
  for (const entry of input.projectedEntries) {
    if (objectRecord(entry.metadata).requiresExplicitGrant !== true) {
      exactProjectionSet = false
      continue
    }
    const toolName = objectRecord(entry.transportConfig).toolName
    if (
      typeof toolName !== 'string'
      || !requiredToolNames.includes(toolName)
      || byToolName.has(toolName)
    ) {
      exactProjectionSet = false
      continue
    }
    byToolName.set(toolName, entry.id)
  }

  const projectedKeys = requiredToolNames
    .map((toolName) => byToolName.get(toolName))
    .filter((policyKey): policyKey is string => Boolean(policyKey))
  const policyKeys = [
    ...projectedKeys,
    ...(input.builtinPolicyKey ? [input.builtinPolicyKey] : []),
  ]
  return {
    configured:
      exactProjectionSet
      && input.projectedEntries.length === requiredToolNames.length
      && policyKeys.length === requiredToolNames.length + 1,
    policyKeys,
    revocationPolicyKeys: [
      ...new Set([
        ...input.projectedEntries.map((entry) => entry.id),
        ...(input.builtinPolicyKey ? [input.builtinPolicyKey] : []),
      ]),
    ],
  }
}

export const loadDeepWaterPolicyKeys = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId: string
    /** The contract access is computed for; the manifest's by default. */
    contractToolNames?: readonly string[]
  },
): Promise<DeepWaterTeamAccess> => {
  const contractToolNames = input.contractToolNames ?? REQUIRED_MCP_TOOL_NAMES
  await ensureBuiltinToolsRegistered(
    prisma,
    input.organizationId,
  )

  const instance = await prisma.mcpServerInstance.findFirst({
    where: {
      organizationId: input.organizationId,
      scopeId: input.teamId,
      scopeType: 'team',
      catalogEntry: {
        name: DEEP_WATER_PRODUCT_SLUG,
        organizationId: null,
        visibility: 'public',
        integratedProducts: {
          some: { slug: DEEP_WATER_PRODUCT_SLUG },
        },
      },
    },
    select: { id: true },
  })
  const [builtin, projectedEntries] = await Promise.all([
    prisma.toolRegistryEntry.findFirst({
      where: {
        organizationId: input.organizationId,
        handlerKind: 'builtin',
        toolId: DEEP_WATER_RUN_UPDATE_TOOL_ID,
      },
      select: {
        enabled: true,
        status: true,
        toolId: true,
      },
    }),
    instance
      ? prisma.toolRegistryEntry.findMany({
          where: {
            mcpInstanceId: instance.id,
            organizationId: input.organizationId,
          },
          select: {
            enabled: true,
            id: true,
            metadata: true,
            status: true,
            transportConfig: true,
          },
        })
      : Promise.resolve([]),
  ])

  // The contract a team is on is the set of names its connector projects,
  // whatever each row's state: a disabled row is an incomplete bundle, a
  // missing or foreign name is another contract.
  const projectedNames = projectedEntries
    .map(toolNameOf)
    .filter((name): name is string => name !== null)
  const contractOutdated = instance !== null
    && !sameNameSet(projectedNames, contractToolNames)
  const resolved = resolveDeepWaterPolicyKeys({
    builtinPolicyKey:
      builtin?.enabled === true && builtin.status === 'active'
        ? builtin.toolId
        : null,
    projectedEntries: projectedEntries
      .filter((entry) => entry.enabled && entry.status === 'active'),
    requiredToolNames: contractToolNames,
  })
  return {
    ...resolved,
    configured: resolved.configured && !contractOutdated,
    contractOutdated,
    revocationPolicyKeys: [
      ...new Set([
        ...projectedEntries.map((entry) => entry.id),
        ...(builtin?.toolId ? [builtin.toolId] : []),
      ]),
    ],
  }
}

const summarizeTarget = (
  target: AgentToolPolicyTarget,
  access: DeepWaterPolicyKeys,
  teamId: string,
): DeepWaterAgentAccessTarget => {
  const grantedToolCount = access.policyKeys.filter(
    (policyKey) => target.toolPolicy[policyKey] === true,
  ).length
  return DeepWaterAgentAccessTargetSchema.parse({
    agentId: target.id,
    agentKind: target.agentKind,
    enabled:
      access.configured
      && grantedToolCount === DEEP_WATER_REQUIRED_TOOL_COUNT,
    grantedToolCount,
    name: target.name,
    revocableGrantCount: [
      ...access.revocationPolicyKeys.filter(
        (policyKey) => policyKey !== DEEP_WATER_RUN_UPDATE_TOOL_ID,
      ),
      deepWaterBundleMarkerKey(teamId),
    ].filter((policyKey) => target.toolPolicy[policyKey] === true).length,
    requiredToolCount: DEEP_WATER_REQUIRED_TOOL_COUNT,
    role: target.role,
  })
}

export const getDeepWaterAgentAccess = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    teamId: string
    userId: string
  },
): Promise<DeepWaterAgentAccessResponse> => {
  const [access, targets] = await Promise.all([
    loadDeepWaterPolicyKeys(prisma, input),
    listAgentToolPolicyTargets(prisma, input.organizationId, input.userId),
  ])
  const summaries = targets.map((target) =>
    summarizeTarget(target, access, input.teamId))
  return DeepWaterAgentAccessResponseSchema.parse({
    configured: access.configured,
    contractOutdated: access.contractOutdated,
    personalAssistant:
      summaries.find((target) => target.agentKind === 'personal_assistant')
      ?? null,
    requiredToolCount: DEEP_WATER_REQUIRED_TOOL_COUNT,
    sharedAgents: summaries.filter((target) => target.agentKind === 'shared'),
  })
}
