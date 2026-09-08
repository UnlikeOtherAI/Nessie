import type { PrismaClient } from '@prisma/client'

/**
 * Transitional project ownership resolver. New projects use Project.teamId;
 * existing rows remain on Team.projectId until an audited backfill proves an
 * unambiguous mapping. A team can own many projects, so callers must supply a
 * project id whenever they are placing content; there is no arbitrary default.
 */
export const resolveTeamProject = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectId: string; teamId: string },
): Promise<{ organizationId: string; projectId: string; teamId: string } | null> => {
  const [team, requestedProject] = await Promise.all([
    prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      project: { select: { id: true, organizationId: true } },
      projects: { where: { id: input.projectId }, select: { id: true, organizationId: true } },
    },
    }),
    prisma.project.findUnique({ where: { id: input.projectId }, select: { teamId: true } }),
  ])
  if (!team) return null
  // A migrated project names its owner directly. Legacy fallback is allowed
  // only while that field is absent, never to bypass another team's ownership.
  if (requestedProject?.teamId && requestedProject.teamId !== input.teamId) return null
  const project = team.projects[0] ?? team.project
  if (project.organizationId !== input.organizationId) return null
  if (project.id !== input.projectId) return null
  return { organizationId: project.organizationId, projectId: project.id, teamId: input.teamId }
}
