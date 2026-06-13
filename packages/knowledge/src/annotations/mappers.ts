import type {
  KnowledgePageAnnotation,
  KnowledgePageAnnotationReaction,
} from '@prisma/client'
import type { AnnotationReaction, AnnotationRecord, TextQuoteAnchor } from './types.js'

const reactionsInclude = {
  reactions: { orderBy: { createdAt: 'asc' as const } },
} as const

// What we always load for an annotation: its reactions, plus (for a top-level
// row) its non-deleted replies — oldest first — each with their own reactions.
export const annotationInclude = {
  ...reactionsInclude,
  replies: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' as const },
    include: reactionsInclude,
  },
} as const

type ReactionRow = KnowledgePageAnnotationReaction
type AnnotationRow = KnowledgePageAnnotation & { reactions?: ReactionRow[] }
type AnnotationRowWithReplies = AnnotationRow & { replies?: AnnotationRow[] }

const toAnchor = (value: KnowledgePageAnnotation['anchor']): TextQuoteAnchor | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.quote !== 'string') return null
  return {
    quote: record.quote,
    prefix: typeof record.prefix === 'string' ? record.prefix : '',
    suffix: typeof record.suffix === 'string' ? record.suffix : '',
    startOffset: typeof record.startOffset === 'number' ? record.startOffset : 0,
  }
}

const mapReaction = (row: ReactionRow): AnnotationReaction => ({
  id: row.id,
  emoji: row.emoji,
  userId: row.userId,
  agentId: row.agentId,
  createdAt: row.createdAt.toISOString(),
})

const mapRow = (row: AnnotationRow, replies: AnnotationRecord[]): AnnotationRecord => ({
  id: row.id,
  pageId: row.pageId,
  spaceId: row.spaceId,
  kind: row.kind,
  state: row.state,
  parentId: row.parentId,
  body: row.body,
  authorType: row.authorType,
  authorId: row.authorId,
  delegatedByAgentId: row.delegatedByAgentId,
  anchor: toAnchor(row.anchor),
  anchorVersionId: row.anchorVersionId,
  orphaned: row.orphaned,
  resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  editedAt: row.editedAt ? row.editedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  reactions: (row.reactions ?? []).map(mapReaction),
  replies,
})

export const mapAnnotation = (row: AnnotationRowWithReplies): AnnotationRecord =>
  mapRow(row, (row.replies ?? []).map((reply) => mapRow(reply, [])))
