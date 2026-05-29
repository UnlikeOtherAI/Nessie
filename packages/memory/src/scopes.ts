import type { Pool } from 'pg'

type Queryable = Pick<Pool, 'query'>

/**
 * The set of memory audiences an agent run may recall from, plus the channel
 * ids it may search past conversations in. This is the single access boundary
 * shared by curated-memory recall (`thoughts`) and conversation search
 * (`messages`/`threads`): a memory or message is eligible only if its scope is
 * in this set, which is derived purely from membership data.
 */
export type AccessibleScopes = {
  /** Zipped with `audienceIds`; values are ThoughtAudienceType literals. */
  audienceTypes: string[]
  audienceIds: string[]
  /** Channel ids in scope, for past-conversation search. */
  channelIds: string[]
}

export type ScopeResolutionMode =
  | 'personal_assistant'
  | 'user_shared'
  | 'autonomous'

export type ResolveAccessibleScopesInput = {
  organizationId: string
  agentId: string
  userId?: string | null
  mode: ScopeResolutionMode
}

type IdRow = { id: string }

const collectIds = (rows: unknown[]): string[] =>
  (rows as IdRow[]).map((row) => row.id)

const userIsOrgMember = async (
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<boolean> => {
  const result = await db.query(
    `SELECT 1 FROM organization_members
     WHERE organization_id = $1 AND user_id = $2 LIMIT 1`,
    [organizationId, userId],
  )
  return (result.rowCount ?? 0) > 0
}

const filterTeamsByMembership = async (
  db: Queryable,
  userId: string,
  candidateTeamIds: string[],
): Promise<string[]> => {
  if (candidateTeamIds.length === 0) {
    return []
  }
  const result = await db.query(
    `SELECT team_id AS id FROM team_members
     WHERE user_id = $1 AND team_id = ANY($2::uuid[])`,
    [userId, candidateTeamIds],
  )
  return collectIds(result.rows)
}

const filterProjectsByMembership = async (
  db: Queryable,
  userId: string,
  candidateProjectIds: string[],
): Promise<string[]> => {
  if (candidateProjectIds.length === 0) {
    return []
  }
  const result = await db.query(
    `SELECT project_id AS id FROM project_members
     WHERE user_id = $1 AND project_id = ANY($2::uuid[])`,
    [userId, candidateProjectIds],
  )
  return collectIds(result.rows)
}

const loadAgentScope = async (
  db: Queryable,
  agentId: string,
): Promise<{ teamId: string | null; projectId: string | null }> => {
  const result = await db.query(
    `SELECT team_id AS "teamId", project_id AS "projectId"
     FROM agents WHERE id = $1`,
    [agentId],
  )
  const row = result.rows[0] as
    | { teamId: string | null; projectId: string | null }
    | undefined
  return { teamId: row?.teamId ?? null, projectId: row?.projectId ?? null }
}

type BoundChannelRow = {
  id: string
  teamId: string | null
  projectId: string | null
}

const loadAgentBoundChannels = async (
  db: Queryable,
  agentId: string,
  organizationId: string,
  userId: string | null,
): Promise<BoundChannelRow[]> => {
  // When a user is present, restrict to channels that user can also access
  // (public, or a member of). When autonomous, every bound channel counts.
  const accessClause = userId
    ? `AND (c.visibility = 'public'
            OR EXISTS (SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = c.id AND cm.user_id = $3))`
    : ''
  const params = userId
    ? [agentId, organizationId, userId]
    : [agentId, organizationId]

  const result = await db.query(
    `SELECT c.id AS id, c.team_id AS "teamId", t.project_id AS "projectId"
     FROM channels c
     JOIN agent_bindings ab ON ab.channel_id = c.id
     LEFT JOIN teams t ON t.id = c.team_id
     WHERE ab.agent_id = $1
       AND c.organization_id = $2
       ${accessClause}`,
    params,
  )
  return result.rows as BoundChannelRow[]
}

const resolvePersonalAssistantScopes = async (
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<{ channelIds: string[]; teamIds: string[]; projectIds: string[] }> => {
  const [channels, teams, projects] = await Promise.all([
    db.query(
      `SELECT c.id FROM channels c
       WHERE c.organization_id = $1
         AND (c.visibility = 'public'
              OR EXISTS (SELECT 1 FROM channel_members cm
                         WHERE cm.channel_id = c.id AND cm.user_id = $2))`,
      [organizationId, userId],
    ),
    db.query(
      `SELECT t.id FROM teams t
       JOIN projects p ON p.id = t.project_id
       WHERE p.organization_id = $1
         AND EXISTS (SELECT 1 FROM team_members tm
                     WHERE tm.team_id = t.id AND tm.user_id = $2)`,
      [organizationId, userId],
    ),
    db.query(
      `SELECT p.id FROM projects p
       WHERE p.organization_id = $1
         AND EXISTS (SELECT 1 FROM project_members pm
                     WHERE pm.project_id = p.id AND pm.user_id = $2)`,
      [organizationId, userId],
    ),
  ])
  return {
    channelIds: collectIds(channels.rows),
    teamIds: collectIds(teams.rows),
    projectIds: collectIds(projects.rows),
  }
}

const dedupe = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value))),
]

const assembleScopes = (input: {
  channelIds: string[]
  teamIds: string[]
  projectIds: string[]
  organizationId: string
  includeOrg: boolean
  userPrivateId: string | null
}): AccessibleScopes => {
  const audienceTypes: string[] = []
  const audienceIds: string[] = []

  for (const id of input.channelIds) {
    audienceTypes.push('channel')
    audienceIds.push(id)
  }
  for (const id of input.teamIds) {
    audienceTypes.push('team')
    audienceIds.push(id)
  }
  for (const id of input.projectIds) {
    audienceTypes.push('project')
    audienceIds.push(id)
  }
  if (input.includeOrg) {
    audienceTypes.push('organization')
    audienceIds.push(input.organizationId)
  }
  if (input.userPrivateId) {
    audienceTypes.push('user')
    audienceIds.push(input.userPrivateId)
  }

  return { audienceTypes, audienceIds, channelIds: input.channelIds }
}

export const resolveAccessibleScopes = async (
  input: ResolveAccessibleScopesInput,
  db: Queryable,
): Promise<AccessibleScopes> => {
  const { organizationId, agentId, mode } = input
  const userId = input.userId ?? null

  if (mode === 'personal_assistant') {
    if (!userId) {
      throw new Error('personal_assistant scope resolution requires a userId')
    }
    const { channelIds, teamIds, projectIds } =
      await resolvePersonalAssistantScopes(db, organizationId, userId)
    return assembleScopes({
      channelIds,
      teamIds,
      projectIds,
      organizationId,
      includeOrg: await userIsOrgMember(db, organizationId, userId),
      userPrivateId: userId,
    })
  }

  const [bound, agentScope] = await Promise.all([
    loadAgentBoundChannels(db, agentId, organizationId, userId),
    loadAgentScope(db, agentId),
  ])
  const channelIds = dedupe(bound.map((row) => row.id))
  const candidateTeamIds = dedupe([
    ...bound.map((row) => row.teamId),
    agentScope.teamId,
  ])
  const candidateProjectIds = dedupe([
    ...bound.map((row) => row.projectId),
    agentScope.projectId,
  ])

  if (mode === 'autonomous') {
    // No requesting user: bound by the agent's own configured scope only.
    return assembleScopes({
      channelIds,
      teamIds: candidateTeamIds,
      projectIds: candidateProjectIds,
      organizationId,
      includeOrg: true,
      userPrivateId: null,
    })
  }

  // user_shared: intersect the agent's reach with what the user can access.
  if (!userId) {
    throw new Error('user_shared scope resolution requires a userId')
  }
  const [teamIds, projectIds, includeOrg] = await Promise.all([
    filterTeamsByMembership(db, userId, candidateTeamIds),
    filterProjectsByMembership(db, userId, candidateProjectIds),
    userIsOrgMember(db, organizationId, userId),
  ])
  return assembleScopes({
    channelIds,
    teamIds,
    projectIds,
    organizationId,
    includeOrg,
    userPrivateId: null,
  })
}
