import type { PrismaClient } from '@prisma/client'

/**
 * Transitional project ownership resolver. New projects use Project.teamId;
 * existing rows remain on Team.projectId until an audited backfill proves an
 * unambiguous mapping. Placement callers supply both ids so there is never an
 * ambient-project fallback.
 */
export const resolveTeamProject = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectId?: string; teamId: string },
): Promise<{ organizationId: string; projectId: string; teamId: string } | null> => {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      project: { select: { id: true, organizationId: true } },
      projects: { select: { id: true, organizationId: true }, take: 2 },
    },
  })
  if (!team || team.projects.length > 1) return null
  const project = team.projects[0] ?? team.project
  if (project.organizationId !== input.organizationId) return null
  if (input.projectId && project.id !== input.projectId) return null
  return { organizationId: project.organizationId, projectId: project.id, teamId: input.teamId }
}
