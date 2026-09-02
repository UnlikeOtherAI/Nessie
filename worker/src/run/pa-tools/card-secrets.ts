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
