export {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  createNativeKnowledgeProvider,
} from './native-provider.js'
export type {
  KnowledgeVersionIndexedEvent,
  NativeKnowledgeProviderOptions,
} from './native-provider.js'
export {
  canReadSpace,
  canWriteSpace,
  loadSpaceViewer,
  readableKnowledgeSpaceWhere,
} from './access.js'
// Mapper + include shape re-exported so callers that need to list pages by a
// filter the KnowledgeProvider interface doesn't expose (e.g. by taskId) can
// query knowledgePage directly and still get the same KnowledgePageRecord shape.
export { mapPage, pageInclude } from './native-mappers.js'
export type { PageRow } from './native-mappers.js'
export type { SpaceViewer, SpaceViewerAgentScopes, SpaceViewerPrincipal } from './access.js'
export {
  readableSpaceIdsSql,
  readableSpaceIdsSqlForAgent,
  readableSpaceIdsSqlForViewer,
} from './native-search-access.js'
export { clampRecentLimit, listNativeRecentPages } from './native-recent-pages.js'
export {
  groupFusedChunksByPage,
  searchNativePagesHybrid,
  snippetAroundMatch,
  truncateSnippet,
} from './native-search-hybrid.js'
export type { GroupedPageHit } from './native-search-hybrid.js'
export {
  extractWikilinks,
  replaceKnowledgePageLinks,
  resolveLinksToPage,
} from './native-links.js'
export type {
  ExtractedWikilink,
  ReplaceKnowledgePageLinksInput,
  ResolveLinksToPageInput,
} from './native-links.js'
export { listBacklinks, listUnlinkedMentions } from './native-links-queries.js'
export type {
  BacklinkRow,
  ListBacklinksInput,
  ListUnlinkedMentionsInput,
  MentionRow,
} from './native-links-queries.js'
export {
  KnowledgeConflictError,
  isKnowledgeConflictError,
  KnowledgeAnnotationError,
  isKnowledgeAnnotationError,
} from './errors.js'
export type { KnowledgeAnnotationErrorCode } from './errors.js'
export { createAnnotationService, findAnnotationLocation } from './annotations/service.js'
export type { AnnotationService } from './annotations/service.js'
export {
  DEFAULT_KNOWLEDGE_CHUNK_SIZE,
  DEFAULT_MIN_CHUNK_CHARACTERS,
  chunkKnowledgePageBody,
} from './chunking.js'
export type { ChunkKnowledgePageBodyOptions, KnowledgePageChunkDraft } from './chunking.js'
export { replaceKnowledgePageVersionChunks } from './native-chunks.js'
export type { ChunkablePage } from './native-chunks.js'
export {
  ensureAgentDocsSpace,
  ensureMyDocsSpace,
  ensureProjectDocumentsSpace,
  ensureTaskFolder,
} from './provisioning.js'
export type { EnsureSpaceResult, TaskFolderTask } from './provisioning.js'
export {
  KnowledgeInferenceOriginError,
  requirePersistedKnowledgeOrigin,
  resolvePersistedKnowledgeOrigin,
} from './inference-origin.js'
export type { PersistedKnowledgeOriginInput } from './inference-origin.js'
export {
  htmlToPlainText,
  computeAnchor,
  relocateAnchor,
  ANCHOR_CONTEXT_LENGTH,
} from '@nessie/schemas'
export type {
  AnnotationAccess,
  AnnotationActor,
  AnnotationKind,
  AnnotationReaction,
  AnnotationRecord,
  AnnotationState,
  TextQuoteAnchor,
} from './annotations/types.js'
export type {
  CreatePageInput,
  CreateSpaceInput,
  KnowledgeAuthorType,
  KnowledgePageKind,
  KnowledgePageRecord,
  KnowledgePageStatus,
  KnowledgePageTreeNode,
  KnowledgePageVersionRecord,
  KnowledgeProvider,
  KnowledgeProviderCapabilities,
  KnowledgeProviderKind,
  KnowledgeRecentPageRecord,
  KnowledgeScopeInput,
  KnowledgeSearchHit,
  KnowledgeSearchPassage,
  KnowledgeSensitivityTier,
  KnowledgeSpaceRecord,
  KnowledgeVisibility,
  HybridSearchPagesInput,
  ListPagesInput,
  ListRecentPagesInput,
  ListSpacesInput,
  MovePageInput,
  PublishPageInput,
  RestorePageVersionInput,
  SearchPagesInput,
  UpdatePageInput,
  UpdateSpaceInput,
} from './types.js'
export { KnowledgePageRevisionConflictError } from './types.js'
