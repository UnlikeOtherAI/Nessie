import type { Prisma, PrismaClient } from '@prisma/client'

export type VisibleAgentWhereInput = {
  organizationId: string
  userId: string
}

export type AgentVisibilityScope = VisibleAgentWhereInput & {
  includeAllOrgChannels?: boolean
}

/**
 * "An agent I steward" as a visibility rule.
 *
 * Both conditions are load-bearing: retained, deactivated memberships do not
 * keep granting access, and permanent spawn_subtask children do not appear in
 * a person's ordinary agent audience.
 */
export const buildOwnedAgentWhere = (
  visibility: AgentVisibilityScope,
): Prisma.AgentWhereInput => ({
  ownerMembership: { deactivatedAt: null },
  ownerUserId: visibility.userId,
  parentAgentId: null,
})

/**
 * The privacy fence over every otherwise-entitled agent read.
 *
 * Keep this beside buildVisibleAgentWhere: agents and all derived resources
 * (including agent-owned documents) must have exactly one audience rule.
 */
export const buildAgentVisibilityWhere = (
  visibility: AgentVisibilityScope,
): Prisma.AgentWhereInput => ({
  OR: [
    { visibility: 'workspace' },
    {
      visibility: 'private',
      ...buildOwnedAgentWhere(visibility),
    },
  ],
})

/**
 * The non-system agents a person is entitled to see through channel reach or
 * live stewardship. Every surface that derives another permission from agent
 * visibility composes this fragment instead of restating either arm.
 */
export const buildVisibleAgentWhere = (
  input: VisibleAgentWhereInput,
): Prisma.AgentWhereInput => ({
  organizationId: input.organizationId,
  systemManaged: false,
  AND: [
    {
      OR: [
        {
          // A bound agent is visible wherever the person can see it working:
          // in a public channel or one they explicitly joined.
          bindings: {
            some: {
              channel: {
                organizationId: input.organizationId,
                OR: [
                  { visibility: 'public' },
                  { members: { some: { userId: input.userId } } },
                ],
              },
            },
          },
        },
        buildOwnedAgentWhere(input),
      ],
    },
    buildAgentVisibilityWhere(input),
  ],
})

export const listVisibleAgentIdsForUser = async (
  prisma: Pick<PrismaClient, 'agent'>,
  input: VisibleAgentWhereInput,
): Promise<string[]> => {
  const agents = await prisma.agent.findMany({
    where: buildVisibleAgentWhere(input),
    select: { id: true },
  })
  return agents.map((agent) => agent.id)
}
