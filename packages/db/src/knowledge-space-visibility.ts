import type { Prisma } from '@prisma/client'
import { buildVisibleAgentWhere } from './agent-visibility.js'

export type VisibleKnowledgeSpaceWhereInput = {
  organizationId: string
  userId: string
}

/**
 * The Prisma form of a human's knowledge-space read access. Query callers use
 * this for relation filters, while @nessie/knowledge keeps the synchronous
 * `canReadSpace` form for already-loaded records. Agent-owned spaces derive
 * their human audience from the same live agent-visibility predicate used by
 * agent lists and detail reads; their stored visibility never widens access.
 */
export const visibleKnowledgeSpaceWhere = (
  input: VisibleKnowledgeSpaceWhereInput,
): Prisma.KnowledgeSpaceWhereInput => ({
  deletedAt: null,
  organizationId: input.organizationId,
  OR: [
    {
      ownerAgentId: { not: null },
      OR: [
        { members: { some: { userId: input.userId } } },
        { ownerAgent: { is: buildVisibleAgentWhere(input) } },
      ],
    },
    {
      ownerAgentId: null,
      OR: [
        { createdBy: input.userId },
        { members: { some: { userId: input.userId } } },
        { visibility: 'organization' },
        {
          visibility: 'project',
          project: { members: { some: { userId: input.userId } } },
        },
      ],
    },
  ],
})
