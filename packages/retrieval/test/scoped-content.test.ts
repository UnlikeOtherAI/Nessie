import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertScopedContentMapping,
  buildInScopesMembershipAccessSql,
  SCOPED_CONTENT_COLUMN_KEYS,
  THOUGHT_SCOPED_CONTENT_MAPPING,
  type ScopedContentMapping,
} from '../src/index.js'

test('thoughts satisfy the shared scoped content contract', () => {
  const mapping = assertScopedContentMapping(THOUGHT_SCOPED_CONTENT_MAPPING)

  assert.equal(mapping.tableName, 'thoughts')
  assert.equal(mapping.deletedAtColumn, 'deleted_at')
  assert.deepEqual(
    Object.keys(mapping.columns).sort(),
    [...SCOPED_CONTENT_COLUMN_KEYS].sort(),
  )
  assert.deepEqual(mapping.columns, {
    channelId: 'channel_id',
    organizationId: 'organization_id',
    privateToAgentId: 'private_to_agent_id',
    projectId: 'project_id',
    sensitivityTier: 'sensitivity_tier',
    teamId: 'team_id',
    threadId: 'thread_id',
    userId: 'user_id',
    visibility: 'visibility',
  })
})

test('scoped content mappings must expose every scoping column', () => {
  const incompleteMapping = {
    columns: {
      channelId: 'channel_id',
      organizationId: 'organization_id',
      privateToAgentId: 'private_to_agent_id',
      projectId: 'project_id',
      sensitivityTier: 'sensitivity_tier',
      teamId: 'team_id',
      threadId: 'thread_id',
      userId: 'user_id',
    },
    contentType: 'knowledge_chunk',
    tableName: 'knowledge_chunks',
  } as ScopedContentMapping

  assert.throws(
    () => assertScopedContentMapping(incompleteMapping),
    /knowledge_chunk is missing scoped column visibility/,
  )
})

test('in-scope access predicate enforces membership and per-agent privacy', () => {
  const sql = buildInScopesMembershipAccessSql({
    currentAudienceIdSql: 'current_audience_id',
    currentAudienceTypeSql: 'current_audience_type',
    mapping: THOUGHT_SCOPED_CONTENT_MAPPING,
    organizationIdSql: 'match_org_id',
    runningAgentIdSql: 'running_agent_id',
    tableAlias: 't',
  })

  assert.match(
    sql.joinSql,
    /ss\.audience_type = resolved\.audience_type/,
  )
  assert.match(sql.joinSql, /ss\.audience_id = resolved\.audience_id/)
  assert.match(sql.whereSql, /t\.organization_id = match_org_id/)
  assert.match(sql.whereSql, /t\.deleted_at IS NULL/)
  assert.match(sql.whereSql, /resolved\.audience_type IS NOT NULL/)
  assert.match(sql.whereSql, /resolved\.audience_id IS NOT NULL/)
  assert.match(sql.whereSql, /thought_audience_compatible_with_output/)
  assert.match(sql.whereSql, /current_audience_type/)
  assert.match(sql.whereSql, /current_audience_id/)
  assert.match(sql.whereSql, /t\.private_to_agent_id IS NULL/)
  assert.match(sql.whereSql, /t\.private_to_agent_id = running_agent_id/)
})
