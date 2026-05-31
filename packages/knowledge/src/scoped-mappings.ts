import { assertScopedContentMapping } from '@nessie/retrieval'

export const KNOWLEDGE_SPACE_SCOPED_CONTENT_MAPPING = assertScopedContentMapping({
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
  contentType: 'knowledge_space',
  deletedAtColumn: 'deleted_at',
  tableName: 'knowledge_spaces',
})

export const KNOWLEDGE_PAGE_SCOPED_CONTENT_MAPPING = assertScopedContentMapping({
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
  contentType: 'knowledge_page',
  deletedAtColumn: 'deleted_at',
  tableName: 'knowledge_pages',
})
