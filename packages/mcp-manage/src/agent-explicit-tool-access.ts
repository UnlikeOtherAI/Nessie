import type { PrismaClient } from '@prisma/client'
import type { AgentToolPolicyTarget } from '@nessie/schemas'
import { setAgentToolPolicyForRegistryEntry } from './agent-tool-policy-registry.js'

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
  return setAgentToolPolicyForRegistryEntry(prisma, input)
}
