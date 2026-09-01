import type { Prisma, PrismaClient } from '@prisma/client'
import type { AgentToolPolicyTarget } from '@nessie/schemas'

import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
  mergeAgentToolPolicy,
  mutateAgentToolPolicy,
  mutateAgentToolPolicyInTransaction,
  registryEntryPolicyKey,
  registryEntryRequiresExplicitPolicy,
} from './agent-tool-policy.js'
import {
  DEEP_WATER_PRODUCT_SLUG,
  runWithDeepWaterTransitionLock,
} from './deepwater-activation.js'
import {
  DEEP_WATER_BUNDLE_MARKER_PREFIX,
  DEEP_WATER_MANUAL_UPDATER_MARKER,
  DEEP_WATER_RUN_UPDATE_TOOL_ID,
} from './deepwater-policy-markers.js'
import {
  DeepWaterActiveRunRevocationError,
  guardDeepWaterPolicyRevocation,
} from './deepwater-revocation-guard.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RegistryDb = PrismaClient | Prisma.TransactionClient
type PolicyInput = {
  agentId: string
  enabled: boolean
  organizationId: string
  toolRegistryEntryId: string
}

type RegistryEntry = NonNullable<
  Awaited<ReturnType<typeof loadRegistryEntry>>
>

const loadRegistryEntry = (
  prisma: RegistryDb,
  input: PolicyInput,
) =>
  prisma.toolRegistryEntry.findFirst({
    where: {
      id: input.toolRegistryEntryId,
      OR: [
        { organizationId: null },
        { organizationId: input.organizationId },
      ],
    },
    select: {
      handlerKind: true,
      id: true,
      metadata: true,
      mcpInstance: {
        select: {
          scopeId: true,
          scopeType: true,
          catalogEntry: {
            select: {
              integratedProducts: { select: { slug: true } },
              name: true,
              organizationId: true,
              visibility: true,
            },
          },
        },
      },
      toolId: true,
    },
  })

const requireExplicitEntry = async (
  prisma: RegistryDb,
  input: PolicyInput,
): Promise<RegistryEntry> => {
  const entry = await loadRegistryEntry(prisma, input)
  if (!entry) {
    throw new AgentToolPolicyError(
      AGENT_TOOL_POLICY_ERROR_CODES.TOOL_NOT_FOUND,
      'Tool registry entry not found.',
    )
  }
  if (!registryEntryRequiresExplicitPolicy(entry)) {
    throw new AgentToolPolicyError(
      AGENT_TOOL_POLICY_ERROR_CODES.TOOL_NOT_EXPLICIT,
      'This endpoint manages only tools that require an explicit per-agent policy grant.',
    )
  }
  return entry
}

const deepWaterTeamId = (entry: RegistryEntry): string | null =>
  entry.handlerKind !== 'builtin'
  && entry.mcpInstance?.scopeType === 'team'
  && entry.mcpInstance.catalogEntry.name === DEEP_WATER_PRODUCT_SLUG
  && entry.mcpInstance.catalogEntry.organizationId === null
  && entry.mcpInstance.catalogEntry.visibility === 'public'
  && entry.mcpInstance.catalogEntry.integratedProducts.some(
    (product) => product.slug === DEEP_WATER_PRODUCT_SLUG,
  )
    ? entry.mcpInstance.scopeId
    : null

const hasDeepWaterProjectionGrant = async (
  tx: Prisma.TransactionClient,
  policy: Record<string, boolean>,
): Promise<boolean> => {
  const ids = Object.entries(policy)
    .filter(([key, enabled]) => enabled && UUID_PATTERN.test(key))
    .map(([key]) => key)
  if (ids.length === 0) return false

  return (
    await tx.toolRegistryEntry.count({
      where: {
        id: { in: ids },
        mcpInstance: {
          catalogEntry: {
            integratedProducts: {
              some: { slug: DEEP_WATER_PRODUCT_SLUG },
            },
            name: DEEP_WATER_PRODUCT_SLUG,
            organizationId: null,
            visibility: 'public',
          },
        },
      },
    })
  ) > 0
}

const translateActiveRunError = (error: unknown): never => {
  if (error instanceof DeepWaterActiveRunRevocationError) {
    throw new AgentToolPolicyError(
      AGENT_TOOL_POLICY_ERROR_CODES.ACTIVE_RUNS,
      error.message,
    )
  }
  throw error
}

const updateEntryPolicy = (
  prisma: PrismaClient,
  tx: Prisma.TransactionClient | null,
  entry: RegistryEntry,
  input: PolicyInput,
): Promise<AgentToolPolicyTarget> => {
  const mutate = tx
    ? (mutation: Parameters<typeof mutateAgentToolPolicy>[1]) =>
        mutateAgentToolPolicyInTransaction(tx, mutation)
    : (mutation: Parameters<typeof mutateAgentToolPolicy>[1]) =>
        mutateAgentToolPolicy(prisma, mutation)

  if (
    entry.handlerKind === 'builtin'
    && entry.toolId === DEEP_WATER_RUN_UPDATE_TOOL_ID
  ) {
    return mutate({
      agentId: input.agentId,
      organizationId: input.organizationId,
      update: async (current, policyTx) => {
        if (input.enabled) {
          return {
            ...current,
            [DEEP_WATER_MANUAL_UPDATER_MARKER]: true,
            [DEEP_WATER_RUN_UPDATE_TOOL_ID]: true,
          }
        }
        if (
          Object.keys(current).some(
            (key) =>
              current[key] === true
              && key.startsWith(DEEP_WATER_BUNDLE_MARKER_PREFIX),
          )
          || await hasDeepWaterProjectionGrant(policyTx, current)
        ) {
          throw new AgentToolPolicyError(
            AGENT_TOOL_POLICY_ERROR_CODES.DEPENDENCY_REQUIRED,
            'Deep Water run updates are managed by an active Deep Water grant. Revoke the dependent research tools first.',
          )
        }
        try {
          await guardDeepWaterPolicyRevocation(policyTx, {
            organizationId: input.organizationId,
          })
        } catch (error) {
          translateActiveRunError(error)
        }
        return mergeAgentToolPolicy(
          current,
          [
            DEEP_WATER_MANUAL_UPDATER_MARKER,
            DEEP_WATER_RUN_UPDATE_TOOL_ID,
          ],
          false,
        )
      },
    })
  }

  return mutate({
    agentId: input.agentId,
    organizationId: input.organizationId,
    update: async (current, policyTx) => {
      const teamId = deepWaterTeamId(entry)
      if (!input.enabled && teamId) {
        try {
          await guardDeepWaterPolicyRevocation(policyTx, {
            organizationId: input.organizationId,
            teamId,
          })
        } catch (error) {
          translateActiveRunError(error)
        }
      }
      return mergeAgentToolPolicy(
        current,
        [registryEntryPolicyKey(entry)],
        input.enabled,
      )
    },
  })
}

export const setAgentToolPolicyForRegistryEntry = async (
  prisma: PrismaClient,
  input: PolicyInput,
): Promise<AgentToolPolicyTarget> => {
  const initialEntry = await requireExplicitEntry(prisma, input)
  const initialTeamId = deepWaterTeamId(initialEntry)
  if (!initialTeamId) {
    return updateEntryPolicy(prisma, null, initialEntry, input)
  }

  return runWithDeepWaterTransitionLock(
    prisma,
    { organizationId: input.organizationId, teamId: initialTeamId },
    async (tx) => {
      const lockedEntry = await requireExplicitEntry(tx, input)
      if (deepWaterTeamId(lockedEntry) !== initialTeamId) {
        throw new AgentToolPolicyError(
          AGENT_TOOL_POLICY_ERROR_CODES.TOOL_NOT_FOUND,
          'Tool registry entry changed while agent access was being updated.',
        )
      }
      return updateEntryPolicy(prisma, tx, lockedEntry, input)
    },
  )
}
