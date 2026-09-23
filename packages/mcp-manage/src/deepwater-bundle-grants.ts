import type { Prisma, PrismaClient } from '@prisma/client'
import {
  AgentToolPolicyError,
  mergeAgentToolPolicy,
  mutateAgentToolPolicyInTransaction,
} from '@nessie/team-admin'
import {
  DEEP_WATER_MANUAL_UPDATER_MARKER,
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
  deepWaterBundleMarkerKey,
  hasDeepWaterBundleMarker,
} from '@nessie/runtime'

import { synchronizeMcpAgentGrant } from './agent-tool-policy-registry.js'
import {
  DEEP_WATER_AGENT_ACCESS_ERROR_CODES,
  DeepWaterAgentAccessError,
  loadDeepWaterPolicyKeys,
  type DeepWaterPolicyKeys,
} from './deepwater-agent-access.js'
import {
  DeepWaterActiveRunRevocationError,
  guardDeepWaterPolicyRevocation,
} from './deepwater-revocation-guard.js'
import { runWithDeepWaterTransitionLock } from './deepwater-transition-lock.js'

/**
 * Granting and revoking a team's DeepWater bundle for an agent. Every path
 * runs inside the team transition lock and takes the agent's policy lock after
 * it, the order every DeepWater path uses.
 */

const DEEP_WATER_PRODUCT_SLUG = 'deep-water'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type DeepWaterProjectedBundle = {
  projectedEntries: Array<{
    id: string
    metadata: unknown
    transportConfig: unknown
  }>
  teamId: string
}

/**
 * The updater builtin is org-wide while the MCP projections are
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

/**
 * Grant an agent the team's whole DeepWater bundle and mark it as a bundle
 * holder, inside the caller's team transition lock (the agent lock is taken
 * here, after it). The caller has checked `access.configured`. A contract
 * upgrade calls it again for every bundle holder, so the grants follow the new
 * projection (operator decision 3).
 */
export const grantDeepWaterBundleInTransaction = async (
  tx: Prisma.TransactionClient,
  input: {
    access: DeepWaterPolicyKeys
    agentId: string
    organizationId: string
    teamId: string
  },
): Promise<void> => {
  const { access } = input
  await mutateAgentToolPolicyInTransaction(tx, {
    agentId: input.agentId,
    organizationId: input.organizationId,
    update: async (currentPolicy, policyTx) => {
      const entries = await policyTx.toolRegistryEntry.findMany({
        where: {
          id: { in: access.policyKeys.filter((key) => UUID_PATTERN.test(key)) },
          handlerKind: 'mcp',
        },
        select: {
          description: true,
          handlerKind: true,
          id: true,
          inputSchema: true,
          metadata: true,
          outputSchema: true,
          toolId: true,
          transportConfig: true,
        },
      })
      for (const entry of entries) {
        await synchronizeMcpAgentGrant(policyTx, entry, {
          agentId: input.agentId,
          enabled: true,
        })
      }
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
      if (input.enabled && access.contractOutdated) {
        throw new DeepWaterAgentAccessError(
          DEEP_WATER_AGENT_ACCESS_ERROR_CODES.CONTRACT_OUTDATED,
          'Deep Water must be updated for this team before it can be granted to agents. An organisation owner updates it by enabling Deep Water for the team again.',
        )
      }
      if (input.enabled && !access.configured) {
        throw new DeepWaterAgentAccessError(
          DEEP_WATER_AGENT_ACCESS_ERROR_CODES.TOOLS_UNAVAILABLE,
          'Deep Water must be enabled with every one of its explicit-grant tools before agent access can change.',
        )
      }

      if (input.enabled) {
        await grantDeepWaterBundleInTransaction(tx, {
          access,
          agentId: input.agentId,
          organizationId: input.organizationId,
          teamId: input.teamId,
        })
      } else {
        await mutateAgentToolPolicyInTransaction(tx, {
          agentId: input.agentId,
          organizationId: input.organizationId,
          update: async (currentPolicy, policyTx) => {
            await guardDeepWaterPolicyRevocation(policyTx, {
              organizationId: input.organizationId,
              teamId: input.teamId,
              mode: { kind: 'agent', agentId: input.agentId },
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
            const entries = await policyTx.toolRegistryEntry.findMany({ where: { id: { in: revokeKeys.filter((key) => UUID_PATTERN.test(key)) }, handlerKind: 'mcp' }, select: { description: true, handlerKind: true, id: true, inputSchema: true, metadata: true, outputSchema: true, toolId: true, transportConfig: true } })
            for (const entry of entries) {
              await synchronizeMcpAgentGrant(policyTx, entry, {
                agentId: input.agentId,
                enabled: false,
              })
            }
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
        error.details,
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
