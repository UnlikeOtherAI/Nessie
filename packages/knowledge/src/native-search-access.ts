import { Prisma } from '@prisma/client'
import type { SpaceViewer } from './access.js'

// Builds the same read-access rule as `canReadSpace` (access.ts), but as a SQL
// subquery so chunk/page search candidates can be scoped in the database
// instead of being fetched and filtered in app code. Keep the two in lockstep:
// creator OR organization-visibility OR (project-visibility AND caller is a
// member of that project) OR explicit space membership. Bypass viewers (agents
// / services) skip this filter entirely at the call site — never call this for
// a bypass viewer, since there is no userId to scope by.
export const readableSpaceIdsSql = (
  organizationId: string,
  viewer: SpaceViewer,
): Prisma.Sql => {
  if (viewer.userId === null) {
    throw new Error('readableSpaceIdsSql requires a non-bypass viewer with a userId')
  }
  const userId = viewer.userId
  const projectIds = Array.from(viewer.projectIds)
  return Prisma.sql`
    SELECT s.id
    FROM knowledge_spaces s
    WHERE s.deleted_at IS NULL
      AND s.organization_id = ${organizationId}::uuid
      AND (
        s.created_by = ${userId}
        OR s.visibility = 'organization'::"ThoughtVisibility"
        ${projectIds.length > 0
          ? Prisma.sql`
            OR (
              s.visibility = 'project'::"ThoughtVisibility"
              AND s.project_id IN (${Prisma.join(projectIds.map((id) => Prisma.sql`${id}::uuid`))})
            )`
          : Prisma.empty}
        OR EXISTS (
          SELECT 1 FROM knowledge_space_members m
          WHERE m.space_id = s.id AND m.user_id = ${userId}::uuid
        )
      )
  `
}
