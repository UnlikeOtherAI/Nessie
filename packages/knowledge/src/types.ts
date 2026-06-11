import type { SpaceViewer } from './access.js'

export type KnowledgeProviderKind =
  | 'first_party'
  | 'github'
  | 'confluence'
  | 'notion'
  | 'wiki'
  | 'url'
  | 'mcp'

export type KnowledgeVisibility =
  | 'private'
  | 'channel'
  | 'team'
  | 'project'
  | 'organization'

export type KnowledgeSensitivityTier = 'normal' | 'sensitive' | 'restricted'
export type KnowledgePageStatus = 'draft' | 'published' | 'archived'
export type KnowledgeAuthorType = 'user' | 'agent'

export type KnowledgeProviderCapabilities = {
  canWrite: boolean
  canIncrementalSync: boolean
  supportsNativeSearch: boolean
  supportsServerSideACL: boolean
  supportsVersionHistory: boolean
  supportsHierarchicalPages: boolean
  supportsDeterministicSearch: boolean
}

export type KnowledgeScopeInput = {
  organizationId: string
  projectId: string
  teamId?: string | null
  channelId?: string | null
  threadId?: string | null
  userId?: string | null
  visibility?: KnowledgeVisibility
  sensitivityTier?: KnowledgeSensitivityTier
  privateToAgentId?: string | null
}

export type KnowledgePageVersionRecord = {
  id: string
  pageId: string
  versionNumber: number
  body: string | null
  bodyRef: string | null
  authorType: KnowledgeAuthorType
  authorId: string
  changeComment: string | null
  createdAt: string
}

export type KnowledgeSpaceRecord = KnowledgeScopeInput & {
  id: string
  name: string
  description: string | null
  metadata: Record<string, unknown> | null
  writeRestricted: boolean
  memberUserIds: string[]
  createdBy: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type KnowledgePageRecord = KnowledgeScopeInput & {
  id: string
  spaceId: string
  title: string
  summary: string | null
  metadata: Record<string, unknown> | null
  parentPageId: string | null
  position: number
  status: KnowledgePageStatus
  labels: string[]
  latestVersion: KnowledgePageVersionRecord | null
  publishedVersion: KnowledgePageVersionRecord | null
  publishedVersionId: string | null
  createdBy: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type KnowledgeSearchHit = {
  page: KnowledgePageRecord
  snippet: string
}

export type KnowledgePageTreeNode = KnowledgePageRecord & {
  childPageIds: string[]
}

export type KnowledgePageCursorPage<T> = {
  data: T[]
  meta: {
    cursor: string | null
    hasMore: boolean
  }
}

export type ListSpacesInput = {
  cursor?: string
  limit?: number
  organizationId: string
  projectId?: string
  // When set (and not a bypass viewer), results are filtered to spaces the
  // viewer is allowed to read.
  viewer?: SpaceViewer
}

export type ListPagesInput = {
  organizationId: string
  spaceId: string
  includeArchived?: boolean
}

export type SearchPagesInput = {
  cursor?: string
  labels?: string[]
  limit?: number
  organizationId: string
  projectId?: string
  query?: string
  spaceId?: string
}

export type CreateSpaceInput = KnowledgeScopeInput & {
  createdBy: string
  description?: string | null
  memberUserIds?: string[]
  metadata?: Record<string, unknown> | null
  name: string
  writeRestricted?: boolean
}

export type UpdateSpaceInput = Partial<{
  description: string | null
  memberUserIds: string[]
  metadata: Record<string, unknown> | null
  name: string
  sensitivityTier: KnowledgeSensitivityTier
  visibility: KnowledgeVisibility
  writeRestricted: boolean
}>

export type CreatePageInput = KnowledgeScopeInput & {
  authorId: string
  authorType: KnowledgeAuthorType
  body?: string | null
  bodyRef?: string | null
  changeComment?: string | null
  createdBy: string
  labels?: string[]
  metadata?: Record<string, unknown> | null
  parentPageId?: string | null
  position?: number
  spaceId: string
  summary?: string | null
  title: string
}

export type UpdatePageInput = Partial<{
  body: string | null
  bodyRef: string | null
  changeComment: string | null
  labels: string[]
  metadata: Record<string, unknown> | null
  sensitivityTier: KnowledgeSensitivityTier
  summary: string | null
  title: string
  visibility: KnowledgeVisibility
}> & {
  authorId: string
  authorType: KnowledgeAuthorType
  organizationId: string
}

export type MovePageInput = {
  organizationId: string
  pageId: string
  parentPageId?: string | null
  position: number
}

export type PublishPageInput = {
  organizationId: string
  pageId: string
}

export type RestorePageVersionInput = {
  authorId: string
  authorType: KnowledgeAuthorType
  changeComment?: string | null
  organizationId: string
  pageId: string
  versionId: string
}

export type KnowledgeProvider = {
  capabilities: KnowledgeProviderCapabilities
  id: string
  kind: KnowledgeProviderKind
  archivePage: (organizationId: string, pageId: string) => Promise<KnowledgePageRecord | null>
  archiveSpace: (organizationId: string, spaceId: string) => Promise<KnowledgeSpaceRecord | null>
  createPage: (input: CreatePageInput) => Promise<KnowledgePageRecord>
  createSpace: (input: CreateSpaceInput) => Promise<KnowledgeSpaceRecord>
  getPage: (organizationId: string, pageId: string) => Promise<KnowledgePageRecord | null>
  getSpace: (organizationId: string, spaceId: string) => Promise<KnowledgeSpaceRecord | null>
  listPages: (input: ListPagesInput) => Promise<KnowledgePageTreeNode[]>
  listSpaces: (input: ListSpacesInput) => Promise<KnowledgePageCursorPage<KnowledgeSpaceRecord>>
  listVersions: (
    organizationId: string,
    pageId: string,
  ) => Promise<KnowledgePageVersionRecord[]>
  movePage: (input: MovePageInput) => Promise<KnowledgePageRecord | null>
  publishPage: (input: PublishPageInput) => Promise<KnowledgePageRecord | null>
  restoreVersion: (input: RestorePageVersionInput) => Promise<KnowledgePageRecord | null>
  searchPages: (input: SearchPagesInput) => Promise<KnowledgePageCursorPage<KnowledgeSearchHit>>
  updatePage: (pageId: string, input: UpdatePageInput) => Promise<KnowledgePageRecord | null>
  updateSpace: (
    organizationId: string,
    spaceId: string,
    input: UpdateSpaceInput,
  ) => Promise<KnowledgeSpaceRecord | null>
}
