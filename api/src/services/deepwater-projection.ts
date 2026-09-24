import type { Prisma } from '@prisma/client'
import type { McpToolDescriptor } from '@nessie/mcp-client'
import {
  isLedgerDeepWaterToolContract,
  projectMcpToolDescriptors,
  regrantDeepWaterBundleHolders,
  retireDeepWaterToolProjections,
  type McpInstanceRow,
} from '@nessie/mcp-manage'

/**
 * Putting a team's DeepWater connector on a tool contract — the manifest's
 * when an owner enables DeepWater. Four cases, decided from the tool names the
 * connector last projected:
 *
 * - `projected` — a new connector: the contract is projected from scratch.
 * - `preserved` — already on this contract: a probed adapter's richer schemas
 *   are kept, only the Ledger endpoint and app key are re-pinned.
 * - `upgraded` — an older Ledger contract (Water plan amendments N9.1): rows
 *   for tools both contracts share keep their registry ids and grants, rows for
 *   dropped tools are removed once no launcher run could still dispatch them,
 *   new tools are inserted, and every holder of the team's bundle marker is
 *   granted the new bundle (operator decision 3).
 * - `replaced` — the legacy direct-provider contract: every old row is
 *   removed and grants must be renewed, so an old tool can never be
 *   dispatched to Ledger and nothing inherits authority it was not given.
 *
 * The caller holds the team transition lock.
 */
export type DeepWaterProjectionOutcome = 'projected' | 'preserved' | 'upgraded' | 'replaced'

const discoveredNames = (discoveredTools: unknown): string[] =>
  Array.isArray(discoveredTools)
    ? discoveredTools
        .map((tool) =>
          tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
            ? (tool as { name: string }).name
            : null)
        .filter((name): name is string => name !== null)
    : []

const sameNameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((name, index) => name === b[index])
}

export const projectDeepWaterTeamContract = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    teamId: string
    instance: McpInstanceRow
    firstProvision: boolean
    descriptors: McpToolDescriptor[]
    ledgerUrl: string
    credentialRef: string
  },
): Promise<DeepWaterProjectionOutcome> => {
  const { instance, descriptors } = input
  const contractToolNames = descriptors.map((descriptor) => descriptor.name)
  const connection = {
    credentialRef: input.credentialRef,
    transportConfig: { transport: 'http', url: input.ledgerUrl },
    lifecycleState: 'active' as const,
    healthFailureCount: 0,
    // Active here means the deterministic Ledger contract is projected.
    healthLastCheckedAt: null,
    lastError: null,
  }

  const outcome: DeepWaterProjectionOutcome = input.firstProvision
    ? 'projected'
    : sameNameSet(discoveredNames(instance.discoveredTools), contractToolNames)
      ? 'preserved'
      : isLedgerDeepWaterToolContract(instance.discoveredTools)
        ? 'upgraded'
        : 'replaced'

  if (outcome === 'preserved') {
    await tx.mcpServerInstance.update({ where: { id: instance.id }, data: connection })
  } else {
    if (outcome === 'upgraded') {
      // Throws, and changes nothing, while a launcher run is open.
      await retireDeepWaterToolProjections(tx, {
        organizationId: input.organizationId,
        teamId: input.teamId,
        instanceId: instance.id,
        contractToolNames,
      })
    } else {
      await tx.toolRegistryEntry.deleteMany({ where: { mcpInstanceId: instance.id } })
    }
    await tx.mcpServerInstance.update({
      where: { id: instance.id },
      data: { ...connection, discoveredTools: descriptors as unknown as object },
    })
    // Upserts by tool id, so an upgrade keeps the ids of shared tools.
    await projectMcpToolDescriptors(tx, {
      organizationId: input.organizationId,
      instance: { id: instance.id, scopeType: 'team', scopeId: input.teamId },
      descriptors,
    })
  }
  // First-party team enable is the review: every projected tool is `active`
  // and needs an explicit per-agent allow.
  await tx.toolRegistryEntry.updateMany({
    where: { mcpInstanceId: instance.id },
    data: { status: 'active', metadata: { requiresExplicitGrant: true } },
  })
  if (outcome === 'upgraded') {
    await regrantDeepWaterBundleHolders(tx, {
      organizationId: input.organizationId,
      teamId: input.teamId,
      contractToolNames,
    })
  }
  return outcome
}
