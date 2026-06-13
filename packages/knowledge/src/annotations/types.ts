import type { KnowledgeAuthorType, KnowledgeSpaceRecord } from '../types.js'
import type { SpaceViewer } from '../access.js'

export type AnnotationKind = 'comment' | 'note'
export type AnnotationState = 'open' | 'resolved'

// W3C / Hypothesis-style text-quote selector. Offsets are into the page body's
// plain-text projection (htmlToPlainText); they are a best-effort tiebreaker —
// relocation is driven by the quote + surrounding context, so notes survive
// edits above them and only orphan when the quoted text itself disappears.
export type TextQuoteAnchor = {
  quote: string
  prefix: string
  suffix: string
  startOffset: number
}

// Who is authoring/acting. A delegating personal assistant authors as its owning
// user (authorType 'user') with delegatedByAgentId set; an autonomous agent
// authors as 'agent'. This mirrors message authorship in the worker.
export type AnnotationActor = {
  authorType: KnowledgeAuthorType
  authorId: string
  delegatedByAgentId?: string | null
}

export type AnnotationRecord = {
  id: string
  pageId: string
  spaceId: string
  kind: AnnotationKind
  state: AnnotationState
  parentId: string | null
  body: string
  authorType: KnowledgeAuthorType
  authorId: string
  delegatedByAgentId: string | null
  anchor: TextQuoteAnchor | null
  anchorVersionId: string | null
  orphaned: boolean
  resolvedAt: string | null
  editedAt: string | null
  createdAt: string
  updatedAt: string
  replies: AnnotationRecord[]
}

// Everything a service method needs to enforce access for one page. `space`
// supplies the read/write facts (visibility, members, …) consumed by
// canReadSpace/canWriteSpace.
export type AnnotationAccess = {
  space: KnowledgeSpaceRecord
  viewer: SpaceViewer
  organizationId: string
  pageId: string
  spaceId: string
}
