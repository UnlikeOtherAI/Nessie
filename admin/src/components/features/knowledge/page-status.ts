import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'

export const pageStatusTone: Record<KnowledgePageRecord['status'], string> = {
  draft: 'text-[var(--warning-text)]',
  published: 'text-[var(--success-text)]',
  archived: 'text-[color:var(--tx3)]',
}
