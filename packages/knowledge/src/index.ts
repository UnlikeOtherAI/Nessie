export {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  createNativeKnowledgeProvider,
} from './native-provider.js'
export type {
  KnowledgeVersionIndexedEvent,
  NativeKnowledgeProviderOptions,
} from './native-provider.js'
export { canReadSpace, canWriteSpace, loadSpaceViewer } from './access.js'
export type { SpaceViewer, SpaceViewerAgentScopes, SpaceViewerPrincipal } from './access.js'
export {
  readableSpaceIdsSql,
  readableSpaceIdsSqlForAgent,
  readableSpaceIdsSqlForViewer,
} from './native-search-access.js'
export {
  groupFusedChunksByPage,
  searchNativePagesHybrid,
  snippetAroundMatch,
  truncateSnippet,
} from './native-search-hybrid.js'
export type { GroupedPageHit } from './native-search-hybrid.js'
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
  KnowledgePageRecord,
  KnowledgePageStatus,
  KnowledgePageTreeNode,
  KnowledgePageVersionRecord,
  KnowledgeProvider,
  KnowledgeProviderCapabilities,
  KnowledgeProviderKind,
  KnowledgeScopeInput,
  KnowledgeSearchHit,
  KnowledgeSearchPassage,
  KnowledgeSensitivityTier,
  KnowledgeSpaceRecord,
  KnowledgeVisibility,
  HybridSearchPagesInput,
  ListPagesInput,
  ListSpacesInput,
  MovePageInput,
  PublishPageInput,
  RestorePageVersionInput,
  SearchPagesInput,
  UpdatePageInput,
  UpdateSpaceInput,
} from './types.js'
