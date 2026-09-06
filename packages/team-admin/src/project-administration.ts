import type { PrismaClient } from '@prisma/client'
import { PROJECT_ADMIN_ROLES } from '@nessie/schemas'

/**
 * Who may change a project's shape — its boards, columns, custom fields and
 * data sources — as opposed to who may read them or work the tasks on them.
 *
 * Board mutations were organisation-owner-only while a project had exactly one
 * board with four columns. With N boards per project, each with its own
 * columns, fields and sources, requiring an organisation owner to rename a
 * column is unworkable. `ProjectMember.role` already exists, is written as
 * `owner` for the person who creates the project, and — until now — gated
 * nothing.
 *
 * This is Nessie-owned data: a project has no UOA counterpart (UOA owns the
 * organisation and its teams, not projects), so gating on this role creates no
 * second identity authority.
 */

export const canAdministerProject = async (
  prisma: PrismaClient,
  viewer: { isOwner: boolean; organizationId: string; userId: string },
  projectId: string,
): Promise<boolean> => {
  const project = await prisma.project.count({
    where: { id: projectId, organizationId: viewer.organizationId },
  })
  if (project === 0) return false
  if (viewer.isOwner) return true
  return (
    (await prisma.projectMember.count({
      where: {
        projectId,
        userId: viewer.userId,
        role: { in: [...PROJECT_ADMIN_ROLES] },
      },
    })) > 0
  )
}
