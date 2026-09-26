import type { PrismaClient } from '@prisma/client'
import type { BudgetScopeType } from '@nessie/runtime'

/**
 * The name of each budget's scope — the organisation's, the team's or the
 * project's — read on the server, where every one of them is visible to the
 * owner reading budgets. The admin used to match ids against its own project
 * and team lists, which show what the viewer may open, so a budget on a
 * project the owner is not a member of read as "Project".
 *
 * `null` means the scope no longer exists in this organisation.
 */
export const withBudgetScopeNames = async <T extends { scopeType: BudgetScopeType; scopeId: string }>(
  prisma: PrismaClient,
  organizationId: string,
  budgets: readonly T[],
): Promise<Array<T & { scopeName: string | null }>> => {
  const idsOf = (scopeType: BudgetScopeType) =>
    budgets.filter((budget) => budget.scopeType === scopeType).map((budget) => budget.scopeId)
  const teamIds = idsOf('team')
  const projectIds = idsOf('project')
  const [organization, teams, projects] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    teamIds.length === 0
      ? Promise.resolve([])
      : prisma.team.findMany({
        where: { id: { in: teamIds }, project: { organizationId } },
        select: { id: true, name: true },
      }),
    projectIds.length === 0
      ? Promise.resolve([])
      : prisma.project.findMany({
        where: { deletedAt: null, id: { in: projectIds }, organizationId },
        select: { id: true, name: true },
      }),
  ])
  const teamNames = new Map(teams.map((team) => [team.id, team.name]))
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  return budgets.map((budget) => ({
    ...budget,
    scopeName:
      budget.scopeType === 'organization'
        ? budget.scopeId === organizationId ? organization?.name ?? null : null
        : budget.scopeType === 'team'
          ? teamNames.get(budget.scopeId) ?? null
          : projectNames.get(budget.scopeId) ?? null,
  }))
}
