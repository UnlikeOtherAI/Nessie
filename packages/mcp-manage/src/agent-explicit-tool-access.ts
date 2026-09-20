import type { PrismaClient } from '@prisma/client'
import type { AgentToolPolicyTarget } from '@nessie/schemas'
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
    select: { handlerKind: true, id: true, metadata: true, toolId: true, mcpInstance: { select: { catalogEntry: { select: { name: true } } } } },
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
    update: (current) => mergeAgentToolPolicy(current, [registryEntryPolicyKey(entry)], input.enabled),
  })
}
