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
// A page is an editable rich-text document or a stored file node (each version
// backed by an Attachment). Folders stay virtual (a document with children).
export type KnowledgePageKind = 'document' | 'file'
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
  // For file nodes: the stored object backing this version.
  attachmentId: string | null
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
  // Output-only ownership fact. It is deliberately absent from
  // KnowledgeScopeInput/CreateSpaceInput: only the dedicated provisioner may
  // mint an agent-owned space (docs/plans/2026-08-31-agent-documents.md §2.1).
  ownerAgentId: string | null
  writeRestricted: boolean
  memberUserIds: string[]
  memberAgentIds: string[]
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
  kind: KnowledgePageKind
  parentPageId: string | null
  position: number
  status: KnowledgePageStatus
  labels: string[]
  // Ticket binding: set when this page is a ticket-bound document (or the
  // ticket's document folder). Loose envelope column — see the schema comment
  // on KnowledgePage.taskId.
  taskId: string | null
  latestVersion: KnowledgePageVersionRecord | null
  publishedVersion: KnowledgePageVersionRecord | null
  publishedVersionId: string | null
  // Optimistic concurrency for the page row itself, incremented on every
  // update. `versionNumber` belongs to a per-version row and cannot serve an
  // `If-Match`; this is what the auto-saving editor states and the API checks.
  revision: number
  createdBy: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type KnowledgeSearchPassage = {
  content: string
  endOffset: number
  score: number
  startOffset: number
}

export type KnowledgeSearchHit = {
  page: KnowledgePageRecord
  snippet: string
  passages?: KnowledgeSearchPassage[]
  score?: number
}

export type KnowledgePageTreeNode = KnowledgePageRecord & {
  childPageIds: string[]
}

// A project's "recently updated documents" row: exactly the fields a recency
// list renders. Deliberately narrower than KnowledgePageRecord — no bodies, no
// version envelopes, no summary — because this feeds a capped, at-a-glance
// list, not a document view.
export type KnowledgeRecentPageRecord = {
  id: string
  spaceId: string
  spaceName: string
  title: string
  kind: KnowledgePageKind
  status: KnowledgePageStatus
  updatedAt: string
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

export type ListRecentPagesInput = {
  organizationId: string
  // Required: this list is always "this project's recent documents".
  projectId: string
  // Defaults to 5, clamped to 20.
  limit?: number
  // When set (and not a bypass viewer), results are pre-filtered in SQL to
  // spaces the viewer is allowed to read (mirrors canReadSpace).
  viewer?: SpaceViewer
}

export type SearchPagesInput = {
  cursor?: string
  labels?: string[]
  limit?: number
  organizationId: string
  projectId?: string
  query?: string
  spaceId?: string
  // When set, results are restricted to pages bound to this ticket.
  taskId?: string
  // When set (and not a bypass viewer), results are pre-filtered in SQL to
  // spaces the viewer is allowed to read (mirrors canReadSpace).
  viewer?: SpaceViewer
}

export type HybridSearchPagesInput = {
  organizationId: string
  query: string
  queryEmbedding: number[] | null
  viewer?: SpaceViewer
  projectId?: string
  spaceId?: string
  // When set, results are restricted to chunks whose page is bound to this
  // ticket.
  taskId?: string
  limit?: number
}

export type CreateSpaceInput = KnowledgeScopeInput & {
  // ownerAgentId is deliberately absent: ordinary callers and agent tools may
  // not claim a space for an agent. The dedicated provisioner writes that
  // ownership fact directly (docs/plans/2026-08-31-agent-documents.md §2.1).
  createdBy: string
  description?: string | null
  memberUserIds?: string[]
  memberAgentIds?: string[]
  metadata?: Record<string, unknown> | null
  name: string
  writeRestricted?: boolean
}

export type UpdateSpaceInput = Partial<{
  description: string | null
  memberUserIds: string[]
  memberAgentIds: string[]
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
  // For file nodes: kind = 'file' and the v1 version is backed by this attachment.
  kind?: KnowledgePageKind
  attachmentId?: string | null
  changeComment?: string | null
  createdBy: string
  labels?: string[]
  metadata?: Record<string, unknown> | null
  parentPageId?: string | null
  position?: number
  spaceId: string
  summary?: string | null
  title: string
  // Binds the created page to a ticket (Task.id). Loose envelope column, no FK.
  taskId?: string | null
}

// Add a new version to a file node, backed by a freshly stored attachment.
export type AddFileVersionInput = {
  organizationId: string
  pageId: string
  attachmentId: string
  authorId: string
  authorType: KnowledgeAuthorType
  changeComment?: string | null
}

/**
 * The caller's `If-Match` revision is not the page's current one: somebody
 * saved in between. The choice is the person's, never a last-write-wins
 * (docs/navigation/overview.md → "Drafts").
 */
export class KnowledgePageRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('Knowledge page revision conflict')
    this.name = 'KnowledgePageRevisionConflictError'
  }
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
  // The revision the caller edited, from `If-Match`. Undefined = no opinion.
  expectedRevision?: number
}

export type MovePageInput = {
  organizationId: string
  pageId: string
  parentPageId?: string | null
  position: number
  // A move is a page edit too. When supplied from If-Match it prevents a
  // stale tree drag from overwriting a colleague's later change.
  expectedRevision?: number
}

export type PublishPageInput = {
  // The authenticated human that made publication happen. Optional for
  // service-level callers; when present, they are excluded from their own
  // publication attention item.
  actorUserId?: string | null
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
  addFileVersion: (input: AddFileVersionInput) => Promise<KnowledgePageVersionRecord | null>
  archivePage: (organizationId: string, pageId: string) => Promise<KnowledgePageRecord | null>
  archiveSpace: (organizationId: string, spaceId: string) => Promise<KnowledgeSpaceRecord | null>
  createPage: (input: CreatePageInput) => Promise<KnowledgePageRecord>
  createSpace: (input: CreateSpaceInput) => Promise<KnowledgeSpaceRecord>
  getPage: (organizationId: string, pageId: string) => Promise<KnowledgePageRecord | null>
  getSpace: (organizationId: string, spaceId: string) => Promise<KnowledgeSpaceRecord | null>
  listPages: (input: ListPagesInput) => Promise<KnowledgePageTreeNode[]>
  listRecentPages: (input: ListRecentPagesInput) => Promise<KnowledgeRecentPageRecord[]>
  listSpaces: (input: ListSpacesInput) => Promise<KnowledgePageCursorPage<KnowledgeSpaceRecord>>
  listVersions: (
    organizationId: string,
    pageId: string,
  ) => Promise<KnowledgePageVersionRecord[]>
  movePage: (input: MovePageInput) => Promise<KnowledgePageRecord | null>
  publishPage: (input: PublishPageInput) => Promise<KnowledgePageRecord | null>
  restoreVersion: (input: RestorePageVersionInput) => Promise<KnowledgePageRecord | null>
  searchPages: (input: SearchPagesInput) => Promise<KnowledgePageCursorPage<KnowledgeSearchHit>>
  searchPagesHybrid?: (
    input: HybridSearchPagesInput,
  ) => Promise<KnowledgePageCursorPage<KnowledgeSearchHit>>
  updatePage: (pageId: string, input: UpdatePageInput) => Promise<KnowledgePageRecord | null>
  updateSpace: (
    organizationId: string,
    spaceId: string,
    input: UpdateSpaceInput,
  ) => Promise<KnowledgeSpaceRecord | null>
}
