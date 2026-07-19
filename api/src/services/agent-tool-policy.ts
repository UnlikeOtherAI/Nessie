import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentToolPolicyTargetSchema,
  type AgentToolPolicyTarget,
} from '@nessie/schemas'
import {
  findProtectedExplicitToolPolicyKeys,
  stripProtectedExplicitToolPolicy,
  SYSTEM_TOOL_DEFINITIONS,
} from '@nessie/runtime'

const EXPLICIT_BUILTIN_IDS = new Set(
  SYSTEM_TOOL_DEFINITIONS
    .filter((tool) => tool.requiresExplicitGrant)
    .map((tool) => tool.id),
)

export const AGENT_TOOL_POLICY_ERROR_CODES = {
  AGENT_NOT_FOUND: 'AGENT_TOOL_POLICY_TARGET_NOT_FOUND',
  ACTIVE_RUNS: 'TOOL_POLICY_ACTIVE_DEEP_WATER_RUNS',
  DEPENDENCY_REQUIRED: 'TOOL_POLICY_DEPENDENCY_REQUIRED',
  PROTECTED_INPUT: 'TOOL_POLICY_PROTECTED_INPUT',
  TOOL_NOT_EXPLICIT: 'TOOL_EXPLICIT_POLICY_NOT_SUPPORTED',
  TOOL_NOT_FOUND: 'TOOL_REGISTRY_ENTRY_NOT_FOUND',
} as const

export class AgentToolPolicyError extends Error {
  override readonly name = 'AgentToolPolicyError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

type RegistryPolicyEntry = {
  handlerKind: string
  id: string
  metadata: unknown
  toolId: string
}

const jsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

export const registryEntryRequiresExplicitPolicy = (
  entry: RegistryPolicyEntry,
): boolean =>
  EXPLICIT_BUILTIN_IDS.has(entry.toolId)
  || jsonRecord(entry.metadata).requiresExplicitGrant === true

/**
 * Builtins are authorized by their stable runtime id. Projected MCP tools are
 * authorized by their registry-row id so replacing a projection cannot inherit
 * a stale grant.
 */
export const registryEntryPolicyKey = (entry: RegistryPolicyEntry): string =>
  entry.handlerKind === 'builtin' ? entry.toolId : entry.id

export const normalizeToolPolicy = (
  value: unknown,
): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(jsonRecord(value)).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  )

export const findProtectedAgentToolPolicyKeys =
  findProtectedExplicitToolPolicyKeys

export const assertGenericAgentToolPolicyInput = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  value: unknown,
): Promise<void> => {
  const protectedKeys = await findProtectedAgentToolPolicyKeys(prisma, value)
  if (protectedKeys.size > 0) {
    throw new AgentToolPolicyError(
      AGENT_TOOL_POLICY_ERROR_CODES.PROTECTED_INPUT,
      'Explicit-grant tools are managed only from the owner Tools or Integrations controls.',
    )
  }
}

/**
 * Generic PUT remains a full replacement for ordinary policy keys, while
 * carrying the server-owned explicit grants and provenance forward from the
 * freshly locked database row. This makes stale designer snapshots harmless.
 */
export const mergeGenericAgentToolPolicy = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  current: unknown,
  requested: unknown,
): Promise<Record<string, boolean>> => {
  await assertGenericAgentToolPolicyInput(prisma, requested)
  const existing = normalizeToolPolicy(current)
  const next = normalizeToolPolicy(requested)
  const protectedKeys = await findProtectedAgentToolPolicyKeys(prisma, existing)
  for (const key of protectedKeys) {
    const value = existing[key]
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

export const stripProtectedAgentToolPolicy =
  stripProtectedExplicitToolPolicy

/**
 * Merge only the requested keys. Revocation removes existing `true` grants,
 * while preserving explicit `false` entries and every unrelated verdict.
 */
export const mergeAgentToolPolicy = (
  current: unknown,
  policyKeys: readonly string[],
  enabled: boolean,
): Record<string, boolean> => {
  const next = normalizeToolPolicy(current)
  for (const policyKey of policyKeys) {
    if (enabled) {
      next[policyKey] = true
    } else if (next[policyKey] === true) {
      delete next[policyKey]
    }
  }
  return next
}

export const acquireAgentToolPolicyLock = async (
  tx: Prisma.TransactionClient,
  agentId: string,
): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${agentId}:tool_policy`}, 0)
    )
  `)
}

const mapTarget = (agent: {
  agentKind: 'personal_assistant' | 'shared'
  id: string
  name: string
  role: string
  toolPolicy: unknown
}): AgentToolPolicyTarget =>
  AgentToolPolicyTargetSchema.parse({
    id: agent.id,
    agentKind: agent.agentKind,
    name: agent.name,
    role: agent.role,
    toolPolicy: normalizeToolPolicy(agent.toolPolicy),
  })

/**
 * Tool-policy administration intentionally has its own minimal target list.
 * The normal agent endpoint keeps system-managed Personal Assistant records
 * hidden because their private bindings/activity are not an admin list surface.
 */
export const listAgentToolPolicyTargets = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<AgentToolPolicyTarget[]> => {
  const agents = await prisma.agent.findMany({
    where: {
      organizationId,
      OR: [
        {
          agentKind: 'personal_assistant',
          systemManaged: true,
        },
        {
          agentKind: 'shared',
          systemManaged: false,
        },
      ],
    },
    orderBy: [{ agentKind: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
    select: {
      agentKind: true,
      id: true,
      name: true,
      role: true,
      toolPolicy: true,
    },
  })
  return agents.map(mapTarget)
}

type AgentToolPolicyMutation = {
  agentId: string
  organizationId: string
  update: (
    current: Record<string, boolean>,
    tx: Prisma.TransactionClient,
  ) => Promise<Record<string, boolean>> | Record<string, boolean>
}

export const mutateAgentToolPolicyInTransaction = async (
  tx: Prisma.TransactionClient,
  input: AgentToolPolicyMutation,
): Promise<AgentToolPolicyTarget> => {
    await acquireAgentToolPolicyLock(tx, input.agentId)

    const agent = await tx.agent.findFirst({
      where: {
        id: input.agentId,
        organizationId: input.organizationId,
        OR: [
          {
            agentKind: 'personal_assistant',
            systemManaged: true,
          },
          {
            agentKind: 'shared',
            systemManaged: false,
          },
        ],
      },
      select: {
        agentKind: true,
        id: true,
        name: true,
        role: true,
        toolPolicy: true,
      },
    })
    if (!agent) {
      throw new AgentToolPolicyError(
        AGENT_TOOL_POLICY_ERROR_CODES.AGENT_NOT_FOUND,
        'Agent is not an editable tool-policy target in this organization.',
      )
    }

    const nextPolicy = await input.update(
      normalizeToolPolicy(agent.toolPolicy),
      tx,
    )
    const updated = await tx.agent.update({
      where: { id: agent.id },
      data: {
        toolPolicy: normalizeToolPolicy(nextPolicy) as Prisma.InputJsonValue,
      },
      select: {
        agentKind: true,
        id: true,
        name: true,
        role: true,
        toolPolicy: true,
      },
    })
    return mapTarget(updated)
}

export const mutateAgentToolPolicy = (
  prisma: PrismaClient,
  input: AgentToolPolicyMutation,
): Promise<AgentToolPolicyTarget> =>
  prisma.$transaction((tx) => mutateAgentToolPolicyInTransaction(tx, input))

export const setAgentToolPolicyKeys = (
  prisma: PrismaClient,
  input: {
    agentId: string
    enabled: boolean
    organizationId: string
    policyKeys: readonly string[]
  },
): Promise<AgentToolPolicyTarget> =>
  mutateAgentToolPolicy(prisma, {
    agentId: input.agentId,
    organizationId: input.organizationId,
    update: (current) =>
      mergeAgentToolPolicy(current, input.policyKeys, input.enabled),
  })
