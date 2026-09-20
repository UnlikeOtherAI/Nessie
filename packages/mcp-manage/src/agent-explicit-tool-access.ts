import type { PrismaClient } from '@prisma/client'
import type { AgentToolPolicyTarget } from '@nessie/schemas'
import { fingerprintMcpToolDescriptor, MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY } from './mcp-tool-grant-fingerprint.js'
import { mcpToolDescriptorAnnotationsFromMetadata } from './mcp-tool-registry-projection.js'
import {
  mutateAgentToolPolicy,
  registryEntryPolicyKey,
  registryEntryRequiresExplicitPolicy,
  mergeAgentToolPolicy,
} from '@nessie/team-admin'

export class AgentExplicitToolAccessError extends Error {
  override readonly name = 'AgentExplicitToolAccessError'
}

/**
 * Shared explicit-grant mutation used by owner controls and delegated Designer
 * tools. Generic agent updates remain deliberately unable to write these keys.
 */
export const setAgentExplicitToolAccess = async (
  prisma: PrismaClient,
  input: { agentId: string; actorUserId: string; enabled: boolean; organizationId: string; toolRegistryEntryId: string },
): Promise<AgentToolPolicyTarget> => {
  const entry = await prisma.toolRegistryEntry.findFirst({
    where: { id: input.toolRegistryEntryId, OR: [{ organizationId: null }, { organizationId: input.organizationId }] },
    select: { description: true, handlerKind: true, id: true, inputSchema: true, metadata: true, outputSchema: true, toolId: true, transportConfig: true, mcpInstance: { select: { catalogEntry: { select: { name: true } } } } },
  })
  if (!entry || !registryEntryRequiresExplicitPolicy(entry)) {
    throw new AgentExplicitToolAccessError('This protected tool is not available in this organization.')
  }
  if (entry.mcpInstance?.catalogEntry.name === 'deep-water') {
    throw new AgentExplicitToolAccessError(
      'Deep Water access is a complete protected bundle. It cannot be granted or revoked one projection at a time.',
    )
  }
  return mutateAgentToolPolicy(prisma, {
    agentId: input.agentId,
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    update: async (current, tx) => {
      if (entry.handlerKind === 'mcp') {
        if (input.enabled) {
          const configured = entry.transportConfig && typeof entry.transportConfig === 'object'
            ? (entry.transportConfig as Record<string, unknown>).toolName : undefined
          const name = typeof configured === 'string' && configured.length > 0
            ? configured : entry.toolId.split(':').at(-1)
          if (!name) throw new AgentExplicitToolAccessError('Protected MCP registry entry has no descriptor name.')
          const config = { [MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]: fingerprintMcpToolDescriptor({ annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata), description: entry.description, inputSchema: entry.inputSchema, name, outputSchema: entry.outputSchema }) }
          const updated = await tx.toolGrant.updateMany({ where: { agentId: input.agentId, roleId: null, toolId: entry.id }, data: { config: config as never, source: 'agent_override' as never, state: 'allowed' } })
          if (updated.count === 0) await tx.toolGrant.create({ data: { agentId: input.agentId, config: config as never, roleId: null, source: 'agent_override' as never, state: 'allowed', toolId: entry.id } })
        } else {
          await tx.toolGrant.updateMany({ where: { agentId: input.agentId, roleId: null, toolId: entry.id }, data: { state: 'denied' } })
        }
      }
      return mergeAgentToolPolicy(current, [registryEntryPolicyKey(entry)], input.enabled)
    },
  })
}
