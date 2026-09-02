import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import type { PillTone } from '../../primitives/Pill'

// The one tone map for a page's status, everywhere it renders as a `Pill`.
export const pageStatusPillTone: Record<KnowledgePageRecord['status'], PillTone> = {
  draft: 'warning',
  published: 'success',
  archived: 'muted',
}

// A page is an unreviewed agent draft when it is still in draft status and
// its most recent version was authored by an agent (the Librarian, today).
// Human drafts and published/archived pages of any authorship render as before.
export const isAgentDraft = (page: KnowledgePageRecord): boolean =>
  page.status === 'draft' && page.latestVersion?.authorType === 'agent'
