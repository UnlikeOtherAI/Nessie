import type { Prisma, PrismaClient } from '@prisma/client'

export type AgentVisibilityInput = {
  organizationId: string
  userId: string
}

/**
 * The ordinary non-system agents a person is entitled to see: agents bound to
 * a public/joined channel, plus top-level agents they actively steward.
 *
 * Keep this as the one Prisma definition of agent visibility. Agent-owned KB
 * spaces delegate to it rather than restating the channel and stewardship
 * rules (docs/plans/2026-08-31-agent-documents.md §4.1).
 */
export const buildVisibleAgentWhere = (
  input: AgentVisibilityInput,
): Prisma.AgentWhereInput => ({
  organizationId: input.organizationId,
  systemManaged: false,
  OR: [
    {
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
      // Liveness and the top-level constraint are re-derived on every read:
      // retained deactivated memberships and spawn_subtask children must not
      // widen visibility (docs/plans/2026-08-31-agent-documents.md §4.3).
      ownerMembership: { deactivatedAt: null },
      ownerUserId: input.userId,
      parentAgentId: null,
    },
  ],
})

/** Resolve the shared visibility predicate to ids for pure access consumers. */
export const listVisibleAgentIdsForUser = async (
  prisma: Pick<PrismaClient, 'agent'>,
  input: AgentVisibilityInput,
): Promise<string[]> => {
  const agents = await prisma.agent.findMany({
    where: buildVisibleAgentWhere(input),
    select: { id: true },
  })
  return agents.map((agent) => agent.id)
}
