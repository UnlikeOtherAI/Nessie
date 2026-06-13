export {
  buildNativeSourceRef,
  buildSpaceSourceRef,
  createNativeKnowledgeProvider,
} from './native-provider.js'
export { canReadSpace, canWriteSpace, loadSpaceViewer } from './access.js'
export type { SpaceViewer } from './access.js'
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
  htmlToPlainText,
  computeAnchor,
  relocateAnchor,
  ANCHOR_CONTEXT_LENGTH,
} from '@nessie/schemas'
export type {
  AnnotationAccess,
  AnnotationActor,
  AnnotationKind,
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
  KnowledgeSensitivityTier,
  KnowledgeSpaceRecord,
  KnowledgeVisibility,
  ListPagesInput,
  ListSpacesInput,
  MovePageInput,
  PublishPageInput,
  RestorePageVersionInput,
  SearchPagesInput,
  UpdatePageInput,
  UpdateSpaceInput,
} from './types.js'
