import type { Prisma, PrismaClient } from '@prisma/client'
import type { AgentToolPolicyTarget } from '@nessie/schemas'
import {
  fingerprintMcpToolDescriptor,
  MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY,
  mcpToolDescriptorAnnotationsFromMetadata,
} from '@nessie/mcp-manage'

import {
  acquireAgentToolPolicyLock,
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
  mergeAgentToolPolicy,
  mutateAgentToolPolicy,
  mutateAgentToolPolicyInTransaction,
  normalizeToolPolicy,
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

const registryEntrySelect = {
  description: true,
  handlerKind: true,
  id: true,
  inputSchema: true,
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
  organizationId: true,
  outputSchema: true,
  toolId: true,
  transportConfig: true,
} satisfies Prisma.ToolRegistryEntrySelect

type RegistryEntry = Prisma.ToolRegistryEntryGetPayload<{
  select: typeof registryEntrySelect
}>

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
    select: registryEntrySelect,
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

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/**
 * Backfill must never convert a descriptor-bound consent into consent for a
 * newer descriptor. Even a malformed present value is retained so runtime
 * authorization fails closed instead of silently approving it.
 */
const grantHasDescriptorFingerprint = (config: unknown): boolean =>
  Object.hasOwn(stringRecord(config), MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY)

/** Mirrors the worker's persisted-registry descriptor name resolution. */
const mcpDescriptorName = (entry: RegistryEntry): string | null => {
  const configuredName = stringRecord(entry.transportConfig).toolName
  if (typeof configuredName === 'string' && configuredName.length > 0) {
    return configuredName
  }
  const separator = entry.toolId.lastIndexOf(':')
  return separator >= 0 && separator < entry.toolId.length - 1
    ? entry.toolId.slice(separator + 1)
    : null
}

/**
 * Keep protected MCP policy and its descriptor-bound agent grant in one
 * transaction. The caller already holds the per-agent policy advisory lock.
 */
const synchronizeMcpAgentGrant = async (
  tx: Prisma.TransactionClient,
  entry: RegistryEntry,
  input: Pick<PolicyInput, 'agentId' | 'enabled'>,
): Promise<void> => {
  if (entry.handlerKind !== 'mcp') return

  if (!input.enabled) {
    // Preserve an explicit deny as the policy-managed tombstone. Role grants
    // remain untouched because direct grants always have a null role id.
    const updated = await tx.toolGrant.updateMany({
      where: { agentId: input.agentId, roleId: null, toolId: entry.id },
      data: {
        source: 'agent_override' as never,
        state: 'denied',
      },
    })
    if (updated.count === 0) {
      await tx.toolGrant.create({
        data: {
          agentId: input.agentId,
          config: {},
          roleId: null,
          source: 'agent_override' as never,
          state: 'denied',
          toolId: entry.id,
        },
      })
    }
    return
  }

  const name = mcpDescriptorName(entry)
  if (!name) {
    throw new AgentToolPolicyError(
      AGENT_TOOL_POLICY_ERROR_CODES.TOOL_NOT_FOUND,
      'Protected MCP registry entry has no descriptor name.',
    )
  }
  const config = {
    [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: fingerprintMcpToolDescriptor({
      annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
      description: entry.description,
      inputSchema: entry.inputSchema,
      name,
      outputSchema: entry.outputSchema,
    }),
  }
  // ToolGrant has no natural Prisma compound key for an agent override. The
  // already-held per-agent advisory lock makes update-then-create an upsert for
  // this service while also restoring a prior denied tombstone.
  const updated = await tx.toolGrant.updateMany({
    where: {
      agentId: input.agentId,
      roleId: null,
      toolId: entry.id,
    },
    data: {
      config: config as Prisma.InputJsonValue,
      source: 'agent_override' as never,
      state: 'allowed',
    },
  })
  if (updated.count === 0) {
    await tx.toolGrant.create({
      data: {
        agentId: input.agentId,
        config: config as Prisma.InputJsonValue,
        roleId: null,
        source: 'agent_override' as never,
        state: 'allowed',
        toolId: entry.id,
      },
    })
  }
}

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
  input: PolicyInput,
  expectedDeepWaterTeamId?: string,
): Promise<AgentToolPolicyTarget> => {
  const mutate = tx
    ? (mutation: Parameters<typeof mutateAgentToolPolicy>[1]) =>
        mutateAgentToolPolicyInTransaction(tx, mutation)
    : (mutation: Parameters<typeof mutateAgentToolPolicy>[1]) =>
        mutateAgentToolPolicy(prisma, mutation)

  return mutate({
    agentId: input.agentId,
    organizationId: input.organizationId,
    update: async (current, policyTx) => {
      // Read the descriptor after acquiring the agent lock. A concurrent probe
      // therefore cannot leave a just-enabled policy paired with an old digest.
      const entry = await requireExplicitEntry(policyTx, input)
      if (
        expectedDeepWaterTeamId
        && deepWaterTeamId(entry) !== expectedDeepWaterTeamId
      ) {
        throw new AgentToolPolicyError(
          AGENT_TOOL_POLICY_ERROR_CODES.TOOL_NOT_FOUND,
          'Tool registry entry changed while agent access was being updated.',
        )
      }
      if (
        entry.handlerKind === 'builtin'
        && entry.toolId === DEEP_WATER_RUN_UPDATE_TOOL_ID
      ) {
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
      }
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
      const nextPolicy = mergeAgentToolPolicy(
        current,
        [registryEntryPolicyKey(entry)],
        input.enabled,
      )
      await synchronizeMcpAgentGrant(policyTx, entry, input)
      return nextPolicy
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
    return updateEntryPolicy(prisma, null, input)
  }

  return runWithDeepWaterTransitionLock(
    prisma,
    { organizationId: input.organizationId, teamId: initialTeamId },
    async (tx) => {
      return updateEntryPolicy(prisma, tx, input, initialTeamId)
    },
  )
}

/**
 * Materialize the legacy protected MCP policy entries before workers begin
 * enforcing descriptor-bound ToolGrants. Re-running is safe: a legacy allow
 * receives a fingerprint only when its direct allowed grant lacks one, while
 * a legacy deny becomes a direct denied tombstone only when no direct grant
 * exists. Any current direct grant remains a person's decision and is never
 * refreshed or overridden at startup.
 */
export const backfillProtectedMcpToolGrants = async (
  prisma: PrismaClient,
): Promise<{ agentCount: number; grantCount: number }> => {
  const candidates = await prisma.agent.findMany({
    select: { id: true, organizationId: true, toolPolicy: true },
  })
  let agentCount = 0
  let grantCount = 0

  for (const candidate of candidates) {
    if (Object.keys(normalizeToolPolicy(candidate.toolPolicy)).length === 0) continue
    const materialized = await prisma.$transaction(async (tx) => {
      await acquireAgentToolPolicyLock(tx, candidate.id)
      const agent = await tx.agent.findUnique({
        where: { id: candidate.id },
        select: { id: true, organizationId: true, toolPolicy: true },
      })
      if (!agent) return 0

      const protectedPolicyEntries = Object.entries(
        normalizeToolPolicy(agent.toolPolicy),
      )
      if (protectedPolicyEntries.length === 0) return 0
      const legacyPolicyByRegistryEntryId = new Map(protectedPolicyEntries)

      const entries = await tx.toolRegistryEntry.findMany({
        where: {
          handlerKind: 'mcp',
          id: { in: [...legacyPolicyByRegistryEntryId.keys()] },
          metadata: { path: ['requiresExplicitGrant'], equals: true },
          OR: [
            { organizationId: null },
            { organizationId: agent.organizationId },
          ],
        },
        select: registryEntrySelect,
      })
      const directAgentGrants = entries.length === 0
        ? []
        : await tx.toolGrant.findMany({
            where: {
              agentId: agent.id,
              roleId: null,
              toolId: { in: entries.map((entry) => entry.id) },
            },
            select: { config: true, state: true, toolId: true },
          })
      const directGrantByToolId = new Map(
        directAgentGrants.map((grant) => [grant.toolId, grant]),
      )
      let materializedGrantCount = 0
      for (const entry of entries) {
        // The JSON predicate makes this true for persisted data; retain the
        // shared policy predicate so this service cannot drift from its route.
        if (!registryEntryRequiresExplicitPolicy(entry)) continue
        const legacyEnabled = legacyPolicyByRegistryEntryId.get(entry.id)
        if (legacyEnabled === undefined) continue
        const directGrant = directGrantByToolId.get(entry.id)
        if (
          directGrant
          && (!legacyEnabled
            || directGrant.state !== 'allowed'
            || grantHasDescriptorFingerprint(directGrant.config))
        ) {
          continue
        }
        await synchronizeMcpAgentGrant(tx, entry, {
          agentId: agent.id,
          enabled: legacyEnabled,
        })
        materializedGrantCount += 1
      }
      return materializedGrantCount
    })
    if (materialized > 0) {
      agentCount += 1
      grantCount += materialized
    }
  }

  return { agentCount, grantCount }
}
