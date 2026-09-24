import type { Prisma } from '@prisma/client'
import { deepWaterBundleMarkerKey } from '@nessie/runtime'

import { loadDeepWaterPolicyKeys } from './deepwater-agent-access.js'
import { grantDeepWaterBundleInTransaction } from './deepwater-bundle-grants.js'
import { guardDeepWaterPolicyRevocation } from './deepwater-revocation-guard.js'

/**
 * Moving a team's Ledger DeepWater connector from one tool contract to the
 * next in place (Water plan amendments N9.1, operator decision 3). The caller
 * holds the team transition lock and re-projects the new contract between
 * these two steps:
 *
 * 1. `retireDeepWaterToolProjections` removes the registry rows of tools the
 *    new contract drops — only once no launcher run is still open, because its
 *    Personal Assistant handoff may yet dispatch through them. Rows for tools
 *    both contracts share keep their ids, so every grant on them survives.
 * 2. `regrantDeepWaterBundleHolders` grants the whole new bundle again to
 *    every agent that holds this team's bundle marker, so an upgrade never
 *    takes DeepWater away from an agent an owner granted it to.
 */

const objectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/**
 * Delete the team connector's rows whose tool the contract no longer has.
 * Throws `DeepWaterActiveRunRevocationError` while a launcher run is open, and
 * then deletes nothing. Returns the retired tool names.
 */
export const retireDeepWaterToolProjections = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId: string
    instanceId: string
    contractToolNames: readonly string[]
  },
): Promise<string[]> => {
  const keep = new Set(input.contractToolNames)
  const rows = await tx.toolRegistryEntry.findMany({
    where: { mcpInstanceId: input.instanceId, organizationId: input.organizationId },
    select: { id: true, toolId: true, transportConfig: true },
  })
  const retired = rows.filter((row) => {
    const toolName = objectRecord(row.transportConfig).toolName
    return typeof toolName !== 'string' || !keep.has(toolName)
  })
  if (retired.length === 0) return []

  await guardDeepWaterPolicyRevocation(tx, {
    organizationId: input.organizationId,
    teamId: input.teamId,
    mode: { kind: 'legacy' },
  })
  // Their grants go with them (tool_grants cascade on the registry entry).
  await tx.toolRegistryEntry.deleteMany({ where: { id: { in: retired.map((row) => row.id) } } })
  return retired.map((row) => {
    const toolName = objectRecord(row.transportConfig).toolName
    return typeof toolName === 'string' ? toolName : row.toolId
  })
}

/**
 * Grant the team's whole bundle, as the connector now projects it, to every
 * agent holding the team's bundle marker. Returns the agents re-granted.
 */
export const regrantDeepWaterBundleHolders = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId: string
    contractToolNames: readonly string[]
  },
): Promise<string[]> => {
  const marker = deepWaterBundleMarkerKey(input.teamId)
  // Ordered, so two upgrades of different teams take agent locks in one order.
  const holders = await tx.agent.findMany({
    where: { organizationId: input.organizationId, toolPolicy: { path: [marker], equals: true } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  if (holders.length === 0) return []

  const access = await loadDeepWaterPolicyKeys(tx, input)
  if (!access.configured) {
    // The bundle cannot be complete (the run updater builtin is disabled), and
    // granting part of it would expose a bundle readiness refuses; the holders
    // keep their marker and are granted when an owner grants them again.
    console.warn(
      `[deep-water] contract upgrade could not re-grant ${holders.length} bundle holder(s) `
      + `for team ${input.teamId}: the bundle is incomplete`,
    )
    return []
  }
  for (const holder of holders) {
    await grantDeepWaterBundleInTransaction(tx, {
      access,
      agentId: holder.id,
      organizationId: input.organizationId,
      teamId: input.teamId,
    })
  }
  return holders.map((holder) => holder.id)
}
