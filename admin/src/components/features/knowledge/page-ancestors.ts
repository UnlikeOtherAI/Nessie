import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'

/**
 * The chain from the space root down to — but not including — the open page:
 * what the document pane's breadcrumb reads.
 *
 * It walks `parentPageId` rather than the drill path, because a document
 * reached by a deep link (or opened into a window of its own) has no drill
 * path to walk. The visited set is not defensive tidiness: a parent link that
 * points back into the chain would otherwise loop forever inside a render.
 *
 * One implementation, used by the work surface and by the document window, so
 * the same document is not filed under two different breadcrumbs.
 */
export const knowledgePageAncestors = (
  page: KnowledgePageRecord | undefined,
  pageById: (pageId: string) => KnowledgePageRecord | undefined,
): KnowledgePageRecord[] => {
  if (!page) return []
  const ancestors: KnowledgePageRecord[] = []
  const visited = new Set<string>([page.id])
  let parent = page.parentPageId ? pageById(page.parentPageId) : undefined
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id)
    ancestors.unshift(parent)
    parent = parent.parentPageId ? pageById(parent.parentPageId) : undefined
  }
  return ancestors
}
