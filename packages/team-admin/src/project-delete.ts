import { Prisma, type PrismaClient } from '@prisma/client'

/**
 * Deleting a project, and the one place that knows what that destroys.
 *
 * The policy used to be five `onDelete` clauses written by five different
 * features plus a single `if` in `DELETE /api/projects/:projectId` that knew
 * about one of them. `Project` has no `deletedAt`, so there is no soft delete to
 * fall back on: a delete is a hard delete, and the honest shape is to refuse
 * until the project is empty and say which family is holding it.
 *
 * The four families, and why each one refuses rather than cascading:
 *
 * - **Channels** (`Channel.project`, Cascade). `DELETE /api/channels/:id`
 *   archives rather than hard-deletes precisely so a conversation is
 *   recoverable; cascading them off the side of a project delete would undo
 *   that. This is the guard that already existed.
 * - **Knowledge spaces and pages** (`KnowledgeSpace.project`,
 *   `KnowledgePage.project`, both Cascade). `KnowledgePage` carries its own
 *   `deletedAt`, so the knowledge base has a recoverable delete of its own; the
 *   FK would take every page, version and chunk past it without asking.
 * - **Executors** (`Executor.project`, Restrict). The database already refuses
 *   this one. Before, it surfaced as an unhandled P2003 → 500 instead of the
 *   409 the channel case got.
 * - **Teams bound to UOA** (`Team.externalTeamId`). A bound `Team` is the local
 *   half of a UOA-owned object. Deleting it locally — with every `TeamMember`
 *   under it — makes the local mirror diverge from the authority in the
 *   destructive direction, and UOA is never told. Unbind or delete the team in
 *   UOA first.
 *
 * The counts and the delete run in one transaction so a channel created between
 * the two is not swept away by the FK, and P2003 is mapped rather than thrown:
 * any family added later refuses instead of 500ing.
 */

export type ProjectDeletionBlockCode =
  | 'PROJECT_NOT_EMPTY'
  | 'PROJECT_HAS_KNOWLEDGE'
  | 'PROJECT_HAS_EXECUTORS'
  | 'PROJECT_HAS_EXTERNAL_TEAMS'

export type ProjectDeletionBlock = {
  code: ProjectDeletionBlockCode
  count: number
  message: string
}

export type DeleteProjectResult =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'blocked'; blocks: ProjectDeletionBlock[] }
  /**
   * A foreign key refused the delete for a family this function does not yet
   * enumerate. Reported as a refusal, never as a crash — the caller maps it to
   * the same 409 the named families get.
   */
  | { kind: 'referenced' }

const blockedBy = (
  code: ProjectDeletionBlockCode,
  count: number,
  message: string,
): ProjectDeletionBlock => ({ code, count, message })

const collectBlocks = (counts: {
  channels: number
  executors: number
  externalTeams: number
  knowledgePages: number
  knowledgeSpaces: number
}): ProjectDeletionBlock[] => {
  const blocks: ProjectDeletionBlock[] = []
  if (counts.channels > 0) {
    blocks.push(blockedBy(
      'PROJECT_NOT_EMPTY',
      counts.channels,
      "Move or delete the project's channels before deleting it",
    ))
  }
  const knowledge = counts.knowledgeSpaces + counts.knowledgePages
  if (knowledge > 0) {
    blocks.push(blockedBy(
      'PROJECT_HAS_KNOWLEDGE',
      knowledge,
      "Move or delete the project's knowledge spaces and pages before deleting it",
    ))
  }
  if (counts.executors > 0) {
    blocks.push(blockedBy(
      'PROJECT_HAS_EXECUTORS',
      counts.executors,
      "Detach or delete the project's executors before deleting it",
    ))
  }
  if (counts.externalTeams > 0) {
    blocks.push(blockedBy(
      'PROJECT_HAS_EXTERNAL_TEAMS',
      counts.externalTeams,
      'This project backs a team in UnlikeOtherAI. Delete the team there first.',
    ))
  }
  return blocks
}

export const deleteProject = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectId: string },
): Promise<DeleteProjectResult> => {
  try {
    return await prisma.$transaction(async (tx): Promise<DeleteProjectResult> => {
      const project = await tx.project.findFirst({
        where: {
          // A channel-root project is the organisation's invisible container
          // for standalone channels. It is not a project anybody may delete.
          channelRoot: false,
          id: input.projectId,
          organizationId: input.organizationId,
        },
        select: {
          id: true,
          _count: {
            select: {
              channels: true,
              executors: true,
              knowledgePages: true,
              knowledgeSpaces: true,
            },
          },
          teams: {
            where: { externalTeamId: { not: null } },
            select: { id: true },
          },
        },
      })
      if (!project) return { kind: 'not_found' }

      const blocks = collectBlocks({
        channels: project._count.channels,
        executors: project._count.executors,
        externalTeams: project.teams.length,
        knowledgePages: project._count.knowledgePages,
        knowledgeSpaces: project._count.knowledgeSpaces,
      })
      if (blocks.length > 0) return { kind: 'blocked', blocks }

      await tx.project.delete({ where: { id: project.id } })
      return { kind: 'deleted' }
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === 'P2003'
    ) {
      return { kind: 'referenced' }
    }
    throw error
  }
}
