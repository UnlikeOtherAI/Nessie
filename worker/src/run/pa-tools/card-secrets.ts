import { isManagedIntegrationInstance } from '@nessie/mcp-manage'
import { type AgentCardSecretDestination, type AgentCardSpec } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'

export type ValidatedCardSecretDestination = {
  key: string
  destination: AgentCardSecretDestination
  /** Human wording the presenter shows instead of an instance id. */
  label: string
}

/**
 * A card's secret fields are checked when the card is **posted**, not when
 * somebody presses it. A card that offers to store a credential somewhere it
 * can never go should not be shown to anybody: the person would type a real
 * secret into it and only then be refused.
 *
 * This is deliberately not an authorization check on the presser — that
 * belongs at the press, where the presser is known, and mirrors the
 * instance-secret route exactly.
 */
export const assertCardSecretDestinations = async (
  context: BuiltinToolRuntimeContext,
  spec: AgentCardSpec,
): Promise<ValidatedCardSecretDestination[]> => {
  const secretBlocks = spec.blocks.flatMap((block) => (block.type === 'secret' ? [block] : []))
  if (secretBlocks.length === 0) return []

  const validated: ValidatedCardSecretDestination[] = []
  for (const block of secretBlocks) {
    // The vault destination names no row to check at post time: the scope is
    // authorized against the presser at the press, where the presser is known,
    // and the name is already constrained by the spec schema.
    if (block.destination.kind === 'vault_secret') {
      validated.push({
        destination: block.destination,
        key: block.key,
        label: block.destination.scopeType === 'personal'
          ? `your Secrets, as ${block.destination.name}`
          : `this ${block.destination.scopeType}'s Secrets, as ${block.destination.name}`,
      })
      continue
    }
    if (block.destination.kind === 'dashboard_source_credential') {
      const source = await context.prisma.dashboardDataSource.findFirst({
        select: { id: true, name: true },
        where: {
          archivedAt: null,
          id: block.destination.sourceId,
          organizationId: context.channel.organizationId,
        },
      })
      if (!source) {
        throw new Error(
          `Field "${block.key}" points at a dashboard source that does not exist here. `
          + 'Create the source before asking for its credential.',
        )
      }
      validated.push({
        destination: block.destination,
        key: block.key,
        label: `the ${source.name} dashboard source`,
      })
      continue
    }

    const instance = await context.prisma.mcpServerInstance.findFirst({
      select: {
        catalogEntry: { select: { displayName: true } },
        id: true,
        organizationId: true,
      },
      where: {
        id: block.destination.instanceId,
        organizationId: context.channel.organizationId,
      },
    })
    if (!instance) {
      throw new Error(
        `Field "${block.key}" points at a connector that does not exist here. `
        + 'Use connector_list to find the instance id.',
      )
    }
    // An integration owns its own credential lifecycle; a card must not be a
    // side door around `MCP_INSTANCE_MANAGED_BY_INTEGRATION`.
    if (
      await isManagedIntegrationInstance(
        context.prisma,
        context.channel.organizationId,
        instance.id,
      )
    ) {
      throw new Error(
        `Field "${block.key}" points at an integration-managed connector, whose credentials `
        + 'are set through its own Integrations toggle.',
      )
    }
    validated.push({
      destination: block.destination,
      key: block.key,
      label: instance.catalogEntry?.displayName ?? 'the connector',
    })
  }
  return validated
}
