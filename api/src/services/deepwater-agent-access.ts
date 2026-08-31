import type { Prisma, PrismaClient } from '@prisma/client'
import {
  DeepWaterAgentAccessResponseSchema,
  DeepWaterAgentAccessTargetSchema,
  type AgentToolPolicyTarget,
  type DeepWaterAgentAccessResponse,
  type DeepWaterAgentAccessTarget,
} from '@nessie/schemas'

import {
  AgentToolPolicyError,
  listAgentToolPolicyTargets,
  mergeAgentToolPolicy,
  mutateAgentToolPolicyInTransaction,
} from './agent-tool-policy.js'
import {
  DEEP_WATER_PRODUCT_SLUG,
  runWithDeepWaterTransitionLock,
} from './deepwater-activation.js'
import { getIntegrationPluginManifest } from './integration-plugin-manifests.js'
import { ensureBuiltinToolsRegistered } from './tools.js'
import {
  DEEP_WATER_MANUAL_UPDATER_MARKER,
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
  deepWaterBundleMarkerKey,
  hasDeepWaterBundleMarker,
} from './deepwater-policy-markers.js'
import {
  DeepWaterActiveRunRevocationError,
  guardDeepWaterPolicyRevocation,
} from './deepwater-revocation-guard.js'

const REQUIRED_MCP_TOOL_NAMES =
  getIntegrationPluginManifest(DEEP_WATER_PRODUCT_SLUG)?.mcp?.tools
    .map((tool) => tool.name) ?? []

export const DEEP_WATER_REQUIRED_TOOL_COUNT =
  REQUIRED_MCP_TOOL_NAMES.length + 1

export const DEEP_WATER_AGENT_ACCESS_ERROR_CODES = {
  ACTIVE_RUNS: 'DEEP_WATER_AGENT_ACCESS_ACTIVE_RUNS',
  AGENT_NOT_FOUND: 'DEEP_WATER_AGENT_NOT_FOUND',
  TOOLS_UNAVAILABLE: 'DEEP_WATER_EXPLICIT_TOOLS_UNAVAILABLE',
} as const

export class DeepWaterAgentAccessError extends Error {
  override readonly name = 'DeepWaterAgentAccessError'

  constructor(public readonly code: string, message: string) {
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

export const resolveDeepWaterPolicyKeys = (
  input: {
    builtinPolicyKey: string | null
    projectedEntries: Array<{
      id: string
      metadata: unknown
      transportConfig: unknown
    }>
  },
): DeepWaterPolicyKeys => {
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
      || !REQUIRED_MCP_TOOL_NAMES.includes(toolName)
      || byToolName.has(toolName)
    ) {
      exactProjectionSet = false
      continue
    }
    byToolName.set(toolName, entry.id)
  }

  const projectedKeys = REQUIRED_MCP_TOOL_NAMES
    .map((toolName) => byToolName.get(toolName))
    .filter((policyKey): policyKey is string => Boolean(policyKey))
  const policyKeys = [
    ...projectedKeys,
    ...(input.builtinPolicyKey ? [input.builtinPolicyKey] : []),
  ]
  return {
    configured:
      exactProjectionSet
      && input.projectedEntries.length === REQUIRED_MCP_TOOL_NAMES.length
      && policyKeys.length === DEEP_WATER_REQUIRED_TOOL_COUNT,
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
  },
): Promise<DeepWaterPolicyKeys> => {
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

  const resolved = resolveDeepWaterPolicyKeys({
    builtinPolicyKey:
      builtin?.enabled === true && builtin.status === 'active'
        ? builtin.toolId
        : null,
    projectedEntries: projectedEntries
      .filter((entry) => entry.enabled && entry.status === 'active'),
  })
  return {
    ...resolved,
    revocationPolicyKeys: [
      ...new Set([
        ...projectedEntries.map((entry) => entry.id),
        ...(builtin?.toolId ? [builtin.toolId] : []),
      ]),
    ],
  }
}

type DeepWaterProjectedBundle = {
  projectedEntries: Array<{
    id: string
    metadata: unknown
    transportConfig: unknown
  }>
  teamId: string
}

/**
 * The updater builtin is org-wide while the five MCP projections are
 * team-specific. Keep that shared allow when another team's exact projection
 * bundle is currently granted to the same agent.
 */
export const resolveDeepWaterRevocationPolicyKeys = (input: {
  builtinPolicyKey: string | null
  currentPolicy: Record<string, boolean>
  currentRevocationPolicyKeys: readonly string[]
  currentTeamId: string
  otherTeamBundles: readonly DeepWaterProjectedBundle[]
}): string[] => {
  const bundleMarker = deepWaterBundleMarkerKey(input.currentTeamId)
  const ownsBuiltin = input.currentPolicy[bundleMarker] === true
  const anotherTeamUsesBuiltin = input.otherTeamBundles.some((bundle) =>
    bundle.projectedEntries.some(
      (entry) => input.currentPolicy[entry.id] === true,
    ))
  const preserveBuiltin =
    !ownsBuiltin
    || input.currentPolicy[DEEP_WATER_MANUAL_UPDATER_MARKER] === true
    || hasDeepWaterBundleMarker(input.currentPolicy, bundleMarker)
    || anotherTeamUsesBuiltin

  return [
    ...input.currentRevocationPolicyKeys.filter(
      (policyKey) =>
        policyKey !== input.builtinPolicyKey || !preserveBuiltin,
    ),
    bundleMarker,
  ]
}

const loadOtherTeamDeepWaterBundles = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId: string
  },
): Promise<DeepWaterProjectedBundle[]> => {
  const instances = await tx.mcpServerInstance.findMany({
    where: {
      organizationId: input.organizationId,
      scopeId: { not: input.teamId },
      scopeType: 'team',
      lifecycleState: 'active',
      catalogEntry: {
        name: DEEP_WATER_PRODUCT_SLUG,
        organizationId: null,
        visibility: 'public',
        integratedProducts: {
          some: { slug: DEEP_WATER_PRODUCT_SLUG },
        },
      },
    },
    select: {
      scopeId: true,
      toolRegistryEntries: {
        where: {
          enabled: true,
          organizationId: input.organizationId,
          status: 'active',
        },
        select: {
          id: true,
          metadata: true,
          transportConfig: true,
        },
      },
    },
  })
  return instances.map((instance) => ({
    projectedEntries: instance.toolRegistryEntries,
    teamId: instance.scopeId,
  }))
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
    personalAssistant:
      summaries.find((target) => target.agentKind === 'personal_assistant')
      ?? null,
    requiredToolCount: DEEP_WATER_REQUIRED_TOOL_COUNT,
    sharedAgents: summaries.filter((target) => target.agentKind === 'shared'),
  })
}

export const setDeepWaterAgentAccess = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    enabled: boolean
    organizationId: string
    teamId: string
  },
): Promise<void> => {
  try {
    await runWithDeepWaterTransitionLock(prisma, input, async (tx) => {
      const access = await loadDeepWaterPolicyKeys(tx, input)
      if (input.enabled && !access.configured) {
        throw new DeepWaterAgentAccessError(
          DEEP_WATER_AGENT_ACCESS_ERROR_CODES.TOOLS_UNAVAILABLE,
          'Deep Water must be enabled with all six explicit-grant tools before agent access can change.',
        )
      }

      if (input.enabled) {
        await mutateAgentToolPolicyInTransaction(tx, {
          agentId: input.agentId,
          organizationId: input.organizationId,
          update: (currentPolicy) => {
            const bundleMarker = deepWaterBundleMarkerKey(input.teamId)
            const next = mergeAgentToolPolicy(
              currentPolicy,
              access.policyKeys,
              true,
            )
            if (
              currentPolicy[DEEP_WATER_RUN_UPDATE_TOOL_ID] === true
              && !hasDeepWaterBundleMarker(currentPolicy)
              && currentPolicy[DEEP_WATER_MANUAL_UPDATER_MARKER] !== true
            ) {
              next[DEEP_WATER_MANUAL_UPDATER_MARKER] = true
            }
            next[bundleMarker] = true
            return next
          },
        })
      } else {
        await mutateAgentToolPolicyInTransaction(tx, {
          agentId: input.agentId,
          organizationId: input.organizationId,
          update: async (currentPolicy, policyTx) => {
            await guardDeepWaterPolicyRevocation(policyTx, {
              organizationId: input.organizationId,
              teamId: input.teamId,
            })
            const otherTeamBundles = await loadOtherTeamDeepWaterBundles(
              policyTx,
              input,
            )
            const builtinPolicyKey = access.revocationPolicyKeys.includes(
              DEEP_WATER_RUN_UPDATE_TOOL_ID,
            )
              ? DEEP_WATER_RUN_UPDATE_TOOL_ID
              : null
            const revokeKeys = resolveDeepWaterRevocationPolicyKeys({
              builtinPolicyKey,
              currentPolicy,
              currentRevocationPolicyKeys: access.revocationPolicyKeys,
              currentTeamId: input.teamId,
              otherTeamBundles,
            })
            return mergeAgentToolPolicy(currentPolicy, revokeKeys, false)
          },
        })
      }
    })
  } catch (error) {
    if (error instanceof DeepWaterActiveRunRevocationError) {
      throw new DeepWaterAgentAccessError(
        DEEP_WATER_AGENT_ACCESS_ERROR_CODES.ACTIVE_RUNS,
        error.message,
      )
    }
    if (error instanceof AgentToolPolicyError) {
      throw new DeepWaterAgentAccessError(
        DEEP_WATER_AGENT_ACCESS_ERROR_CODES.AGENT_NOT_FOUND,
        'Agent is not an editable Deep Water target in this organization.',
      )
    }
    throw error
  }
}
