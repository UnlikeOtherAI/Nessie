import { Prisma, type PrismaClient } from '@prisma/client'
import {
  findProtectedExplicitToolPolicyKeys,
  stripProtectedExplicitToolPolicy,
  SYSTEM_TOOL_DEFINITIONS,
} from '@nessie/runtime'

/**
 * The part of agent tool-policy administration that every writer of an agent
 * row needs: the protected-key gate. It is shared with the worker because the
 * personal assistant's `agent_create` tool writes agents through the same
 * `createAgentRecord`, and a tool-authored policy must be refused for exactly
 * the keys a hand-authored one is (`requiresExplicitGrant` builtins and the
 * DeepWater provenance markers). The owner-only target list and the locked
 * policy-target mutations stay in the API, which is their only surface.
 */

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
