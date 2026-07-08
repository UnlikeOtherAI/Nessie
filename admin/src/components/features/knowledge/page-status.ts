import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'

export const pageStatusTone: Record<KnowledgePageRecord['status'], string> = {
  draft: 'text-[var(--warning-text)]',
  published: 'text-[var(--success-text)]',
  archived: 'text-[color:var(--tx3)]',
}

// A page is an unreviewed agent draft when it is still in draft status and
// its most recent version was authored by an agent (the Librarian, today).
// Human drafts and published/archived pages of any authorship render as before.
export const isAgentDraft = (page: KnowledgePageRecord): boolean =>
  page.status === 'draft' && page.latestVersion?.authorType === 'agent'
