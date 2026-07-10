import { Prisma } from '@prisma/client'
import type { SpaceViewer, SpaceViewerAgentScopes } from './access.js'

// Builds the same read-access rule as `canReadSpace` (access.ts), but as a SQL
// subquery so chunk/page search candidates can be scoped in the database
// instead of being fetched and filtered in app code. Keep the two in lockstep:
// creator OR organization-visibility OR (project-visibility AND caller is a
// member of that project) OR explicit space membership. Bypass viewers
// (service actors) skip this filter entirely at the call site — never call
// this for a bypass viewer, since there is no userId to scope by.
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

// One arm of the agent read-access rule: `s.<column> IN (ids)` guarded by the
// matching visibility, or `Prisma.empty` when the agent has no ids to scope
// by. `column` is a fixed, non-user-controlled identifier (never request
// input), so Prisma.raw is safe here.
const scopedVisibilityArm = (
  visibility: 'project' | 'team' | 'channel',
  column: string,
  ids: Set<string>,
): Prisma.Sql => {
  const values = Array.from(ids)
  if (values.length === 0) return Prisma.empty
  return Prisma.sql`
    OR (
      s.visibility = ${Prisma.raw(`'${visibility}'`)}::"ThoughtVisibility"
      AND ${Prisma.raw(column)} IN (${Prisma.join(values.map((id) => Prisma.sql`${id}::uuid`))})
    )`
}

// Mirrors `canReadSpace`'s agent arm exactly: restricted spaces are excluded
// outright, then privateToAgentId / creator / explicit member grants, then
// visibility-scoped reach (organization / project / team / channel). `private`
// visibility has no agent arm, matching the app-level rule.
export const readableSpaceIdsSqlForAgent = (
  organizationId: string,
  agent: SpaceViewerAgentScopes,
): Prisma.Sql => {
  const memberSpaceIds = Array.from(agent.memberSpaceIds)
  return Prisma.sql`
    SELECT s.id
    FROM knowledge_spaces s
    WHERE s.deleted_at IS NULL
      AND s.organization_id = ${organizationId}::uuid
      AND s.sensitivity_tier <> 'restricted'::"SensitivityTier"
      AND (
        s.private_to_agent_id = ${agent.id}::uuid
        OR s.created_by = ${agent.id}
        ${memberSpaceIds.length > 0
          ? Prisma.sql`OR s.id IN (${Prisma.join(memberSpaceIds.map((id) => Prisma.sql`${id}::uuid`))})`
          : Prisma.empty}
        ${agent.orgBound ? Prisma.sql`OR s.visibility = 'organization'::"ThoughtVisibility"` : Prisma.empty}
        ${scopedVisibilityArm('project', 's.project_id', agent.projectIds)}
        ${scopedVisibilityArm('team', 's.team_id', agent.teamIds)}
        ${scopedVisibilityArm('channel', 's.channel_id', agent.channelIds)}
      )
  `
}

// Picks the readable-space-ids fragment for whichever viewer kind is present:
// no filter for a bypass (service) viewer, the agent arm for an agent viewer,
// the user arm otherwise. Returns null when no filter should be applied
// (bypass, or no viewer supplied) — callers skip the `space_id IN (...)`
// predicate entirely in that case.
export const readableSpaceIdsSqlForViewer = (
  organizationId: string,
  viewer: SpaceViewer,
): Prisma.Sql | null => {
  if (viewer.bypass) return null
  if (viewer.agent) return readableSpaceIdsSqlForAgent(organizationId, viewer.agent)
  return readableSpaceIdsSql(organizationId, viewer)
}
