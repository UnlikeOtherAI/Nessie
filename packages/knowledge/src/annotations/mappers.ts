import type { KnowledgePageAnnotation } from '@prisma/client'
import type { AnnotationRecord, TextQuoteAnchor } from './types.js'

// What we always load alongside a top-level annotation: its non-deleted replies,
// oldest first (a reading order under the parent).
export const repliesInclude = {
  replies: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

type AnnotationRow = KnowledgePageAnnotation
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
  replies,
})

export const mapAnnotation = (row: AnnotationRowWithReplies): AnnotationRecord =>
  mapRow(row, (row.replies ?? []).map((reply) => mapRow(reply, [])))
