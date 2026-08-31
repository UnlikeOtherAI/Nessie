import { Prisma } from '@prisma/client'
import type { SpaceViewer, SpaceViewerAgentScopes } from './access.js'

// Builds the same read-access rule as `canReadSpace` (access.ts), but as a SQL
// subquery so chunk/page search candidates can be scoped in the database
// instead of being fetched and filtered in app code. Keep the two in lockstep:
// explicit membership OR agent-owned-space visibility OR, for ordinary spaces,
// creator / organization / project visibility. Bypass viewers (service actors)
// skip this filter entirely at the call site — never call this for a bypass
// viewer, since there is no userId to scope by.
export const readableSpaceIdsSql = (
  organizationId: string,
  viewer: SpaceViewer,
): Prisma.Sql => {
  if (viewer.userId === null) {
    throw new Error('readableSpaceIdsSql requires a non-bypass viewer with a userId')
  }
  const userId = viewer.userId
  const projectIds = Array.from(viewer.projectIds)
  const visibleAgentIds = Array.from(viewer.visibleAgentIds)
  return Prisma.sql`
    SELECT s.id
    FROM knowledge_spaces s
    WHERE s.deleted_at IS NULL
      AND s.organization_id = ${organizationId}::uuid
      AND (
        EXISTS (
          SELECT 1 FROM knowledge_space_members m
          WHERE m.space_id = s.id AND m.user_id = ${userId}::uuid
        )
        ${visibleAgentIds.length > 0
          ? Prisma.sql`
            OR (
              -- Agent visibility was resolved once by loadUserViewer; do not
              -- restate it here (docs/plans/2026-08-31-agent-documents.md §4.1).
              s.owner_agent_id IS NOT NULL
              AND s.owner_agent_id = ANY(${visibleAgentIds}::uuid[])
            )`
          : Prisma.empty}
        OR (
          -- Agent-owned spaces must not fall through to ordinary KB
          -- visibility; their stored private visibility is only a fail-closed
          -- floor (docs/plans/2026-08-31-agent-documents.md §4.1).
          s.owner_agent_id IS NULL
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
          )
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
// outright, then privateToAgentId / creator / explicit member / docs proprietor
// grants, then visibility-scoped reach (organization / project / team /
// channel). `private` visibility has no other agent arm, matching the app-level
// rule.
export const readableSpaceIdsSqlForAgent = (
  organizationId: string,
  agent: SpaceViewerAgentScopes,
): Prisma.Sql => {
  const memberSpaceIds = Array.from(agent.memberSpaceIds)
  const ownerAgentIds = [agent.id, ...(agent.parentAgentId ? [agent.parentAgentId] : [])]
  return Prisma.sql`
    SELECT s.id
    FROM knowledge_spaces s
    WHERE s.deleted_at IS NULL
      AND s.organization_id = ${organizationId}::uuid
      AND s.sensitivity_tier <> 'restricted'::"SensitivityTier"
      AND (
        (
          -- A subtask child shares its parent's documents home instead of
          -- minting a second one (docs/plans/2026-08-31-agent-documents.md §4.1).
          s.owner_agent_id IS NOT NULL
          AND s.owner_agent_id = ANY(${ownerAgentIds}::uuid[])
        )
        OR s.private_to_agent_id = ${agent.id}::uuid
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
