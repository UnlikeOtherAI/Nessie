import { Prisma, type PrismaClient } from '@prisma/client'

/**
 * Deleting a project, and the one place that decides what that does.
 *
 * **A delete is a soft delete.** `Project.deletedAt` is stamped, and so is
 * `deletedAt` (with `archivedAt`) on every channel still in the project, in one
 * transaction. No row is removed — boards, tasks, fields, sources, iterations,
 * members, channels and their history all stay intact for a future restore —
 * and every project and channel read filters `deletedAt: null`, so the project
 * and its rooms are gone for everybody the moment it commits
 * (`docs/standards/team-model.md` → "Deleting a project or a channel").
 *
 * Channels no longer block: they are soft-deleted with the project, which is
 * exactly as recoverable as the channel archive the old guard protected.
 *
 * Three families still refuse, because their data is reachable from surfaces
 * that do not pass through the project's own entitlement, so hiding the project
 * would not hide them:
 *
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
 * The counts and the stamps run in one transaction, so a knowledge page created
 * between the two cannot slip under a project that is being hidden.
 */

export type ProjectDeletionBlockCode =
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
  executors: number
  externalTeams: number
  knowledgePages: number
  knowledgeSpaces: number
}): ProjectDeletionBlock[] => {
  const blocks: ProjectDeletionBlock[] = []
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
          deletedAt: null,
          id: input.projectId,
          organizationId: input.organizationId,
        },
        select: {
          id: true,
          _count: {
            select: {
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
        executors: project._count.executors,
        externalTeams: project.teams.length,
        knowledgePages: project._count.knowledgePages,
        knowledgeSpaces: project._count.knowledgeSpaces,
      })
      if (blocks.length > 0) return { kind: 'blocked', blocks }

      const now = new Date()
      await tx.channel.updateMany({
        where: { projectId: project.id, archivedAt: null, deletedAt: null },
        data: { archivedAt: now, deletedAt: now },
      })
      await tx.channel.updateMany({
        where: { projectId: project.id, deletedAt: null },
        data: { deletedAt: now },
      })
      await tx.project.update({ where: { id: project.id }, data: { deletedAt: now } })
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
