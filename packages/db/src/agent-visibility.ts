import type { Prisma, PrismaClient } from '@prisma/client'

export type VisibleAgentWhereInput = {
  organizationId: string
  userId: string
}

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
  OR: [
    {
      // A bound agent is visible wherever the person can see it working: in a
      // public channel or one they explicitly joined. Agent documents inherit
      // this exact audience; see docs/plans/2026-08-31-agent-documents.md §4.1.
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
    {
      // Stewardship is re-derived through the live membership, and permanent
      // spawn_subtask children stay out of human visibility. Agent documents
      // must lose this arm at the same instant; see the plan's §4.1/§4.3.
      ownerMembership: { deactivatedAt: null },
      ownerUserId: input.userId,
      parentAgentId: null,
    },
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
