export type ScopedContentVisibility =
  | 'private'
  | 'channel'
  | 'team'
  | 'project'
  | 'organization'

export type ScopedContentAudienceType =
  | 'user'
  | 'channel'
  | 'team'
  | 'project'
  | 'organization'

export type ScopedContentSensitivityTier =
  | 'normal'
  | 'sensitive'
  | 'restricted'

export type ScopedContentRecord = {
  id: string
  organizationId: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  threadId: string | null
  userId: string | null
  visibility: ScopedContentVisibility
  sensitivityTier: ScopedContentSensitivityTier
  privateToAgentId: string | null
}

export const SCOPED_CONTENT_COLUMN_KEYS = [
  'organizationId',
  'projectId',
  'teamId',
  'channelId',
  'threadId',
  'userId',
  'visibility',
  'sensitivityTier',
  'privateToAgentId',
] as const

export type ScopedContentColumnKey = typeof SCOPED_CONTENT_COLUMN_KEYS[number]

export type ScopedContentMapping = {
  columns: Record<ScopedContentColumnKey, string>
  contentType: string
  deletedAtColumn?: string
  tableName: string
}

export type ScopedMembershipAccessSql = {
  joinSql: string
  whereSql: string
}

export const assertScopedContentMapping = <T extends ScopedContentMapping>(
  mapping: T,
): T => {
  for (const key of SCOPED_CONTENT_COLUMN_KEYS) {
    if (!mapping.columns[key]) {
      throw new Error(`${mapping.contentType} is missing scoped column ${key}`)
    }
  }

  return mapping
}

export const THOUGHT_SCOPED_CONTENT_MAPPING = assertScopedContentMapping({
  columns: {
    channelId: 'channel_id',
    organizationId: 'organization_id',
    privateToAgentId: 'private_to_agent_id',
    projectId: 'project_id',
    sensitivityTier: 'sensitivity_tier',
    teamId: 'team_id',
    threadId: 'thread_id',
    userId: 'user_id',
    visibility: 'visibility',
  },
  contentType: 'thought',
  deletedAtColumn: 'deleted_at',
  tableName: 'thoughts',
})

const columnRef = (
  tableAlias: string,
  mapping: ScopedContentMapping,
  column: ScopedContentColumnKey,
): string => `${tableAlias}.${mapping.columns[column]}`

export const buildInScopesMembershipAccessSql = (input: {
  currentAudienceIdSql?: string
  currentAudienceTypeSql?: string
  compatibilitySqlFunction?: string
  mapping: ScopedContentMapping
  organizationIdSql: string
  resolvedAlias?: string
  runningAgentIdSql: string
  scopeSetAlias?: string
  tableAlias?: string
}): ScopedMembershipAccessSql => {
  const tableAlias = input.tableAlias ?? 't'
  const scopeSetAlias = input.scopeSetAlias ?? 'ss'
  const resolvedAlias = input.resolvedAlias ?? 'resolved'
  const compatibilitySqlFunction =
    input.compatibilitySqlFunction ?? 'thought_audience_compatible_with_output'
  const privateToAgent = columnRef(
    tableAlias,
    input.mapping,
    'privateToAgentId',
  )
  const deletedPredicate = input.mapping.deletedAtColumn
    ? `AND ${tableAlias}.${input.mapping.deletedAtColumn} IS NULL`
    : ''
  const compatibilityPredicate =
    input.currentAudienceTypeSql && input.currentAudienceIdSql
      ? `AND ${compatibilitySqlFunction}(
        ${resolvedAlias}.audience_type,
        ${resolvedAlias}.audience_id,
        ${input.currentAudienceTypeSql},
        ${input.currentAudienceIdSql},
        ${columnRef(tableAlias, input.mapping, 'organizationId')}
      )`
      : ''

  return {
    joinSql: `JOIN scope_set AS ${scopeSetAlias}
      ON ${scopeSetAlias}.audience_type = ${resolvedAlias}.audience_type
     AND ${scopeSetAlias}.audience_id = ${resolvedAlias}.audience_id`,
    whereSql: `${columnRef(tableAlias, input.mapping, 'organizationId')} = ${input.organizationIdSql}
      ${deletedPredicate}
      AND ${resolvedAlias}.audience_type IS NOT NULL
      AND ${resolvedAlias}.audience_id IS NOT NULL
      ${compatibilityPredicate}
      AND (
        ${privateToAgent} IS NULL
        OR ${privateToAgent} = ${input.runningAgentIdSql}
      )`,
  }
}
