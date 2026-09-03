import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AgentToolPolicyTargetSchema,
  type AgentToolPolicyTarget,
} from '@nessie/schemas'
import {
  acquireAgentToolPolicyLock,
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
  buildAgentVisibilityWhere,
  mergeAgentToolPolicy,
  normalizeToolPolicy,
} from '@nessie/team-admin'

// The protected-key gate and the policy merge helpers moved to
// `@nessie/team-admin` when agent creation became shared with the worker;
// they are re-exported here so every existing importer keeps one import site.
export {
  acquireAgentToolPolicyLock,
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
  assertGenericAgentToolPolicyInput,
  findProtectedAgentToolPolicyKeys,
  mergeAgentToolPolicy,
  mergeGenericAgentToolPolicy,
  normalizeToolPolicy,
  registryEntryPolicyKey,
  registryEntryRequiresExplicitPolicy,
  stripProtectedAgentToolPolicy,
} from '@nessie/team-admin'

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
  userId: string,
): Promise<AgentToolPolicyTarget[]> => {
  const agents = await prisma.agent.findMany({
    where: {
      AND: [buildAgentVisibilityWhere({ organizationId, userId })],
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
