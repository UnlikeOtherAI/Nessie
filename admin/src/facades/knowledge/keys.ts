// Knowledge-base cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const knowledgeKeys = {
  annotations: (pageId?: string) =>
    ['knowledge-annotations', pageId ?? 'none'] as const,
  annotationsByKind: (pageId?: string, kind?: string) =>
    ['knowledge-annotations', pageId ?? 'none', kind ?? 'all'] as const,
  attachments: (pageId?: string) =>
    ['knowledge-page-attachments', pageId ?? 'none'] as const,
  // Backlinks and mentions are views of one page's links, so they nest under
  // that page: editing a page invalidates them along with its body.
  backlinks: (pageId?: string) =>
    ['knowledge-page', pageId ?? 'none', 'backlinks'] as const,
  mentions: (pageId?: string) =>
    ['knowledge-page', pageId ?? 'none', 'mentions'] as const,
  myDocs: ['knowledge-my-docs'] as const,
  // The Finder's virtual folders. Each is its own corpus computed by the
  // server across every readable space, so neither nests under a space's
  // pages: there is no space id to nest them by.
  latest: (projectId?: string) =>
    ['knowledge-latest', projectId ?? 'organization'] as const,
  page: (pageId?: string) => ['knowledge-page', pageId ?? 'none'] as const,
  // Get Info and the share list are views of one page, so they nest under it:
  // a rename or a share invalidates the page and reaches both.
  pageInfo: (pageId?: string) => ['knowledge-page', pageId ?? 'none', 'info'] as const,
  pageShares: (pageId?: string) => ['knowledge-page', pageId ?? 'none', 'shares'] as const,
  pages: (spaceId?: string) => ['knowledge-pages', spaceId ?? 'none'] as const,
  root: ['knowledge-root'] as const,
  // The subtree of one shared folder inside a space the viewer cannot
  // otherwise read — a different corpus from that space's whole page list,
  // and deliberately a different entry so it cannot be served in its place.
  sharedSubtree: (spaceId?: string, rootPageId?: string) =>
    ['knowledge-pages', spaceId ?? 'none', 'shared', rootPageId ?? 'none'] as const,
  sharedWithMe: ['knowledge-shared-with-me'] as const,
  spaceInfo: (spaceId?: string) => ['knowledge-spaces', spaceId ?? 'none', 'info'] as const,
  // A queued cross-space transfer, addressed by its own job id. It is not a
  // view of any one space or page — it spans two spaces and the rows it is
  // moving change identity under it — so it gets its own entry rather than
  // nesting under either end.
  transfer: (transferId?: string) => ['knowledge-transfer', transferId ?? 'none'] as const,
  recentPages: (projectId: string | undefined, limit: number) =>
    ['knowledge-recent-pages', projectId ?? 'none', limit] as const,
  // A project-scoped list is a different corpus from the org-wide one, so it
  // gets its own entry under the shared spaces root.
  scopedSpaces: (projectId?: string) =>
    ['knowledge-spaces', projectId ?? 'organization'] as const,
  space: (spaceId?: string) => ['knowledge-spaces', spaceId ?? 'none'] as const,
  spaces: ['knowledge-spaces'] as const,
  storageUsage: (scopeType: string, scopeId?: string) =>
    ['knowledge-storage-usage', scopeType, scopeId ?? 'self'] as const,
  versions: (pageId?: string) => ['knowledge-versions', pageId ?? 'none'] as const,
  wikilinkSuggestions: (query: string) =>
    ['knowledge-wikilink-suggestions', query] as const,
  zip: (pageId?: string, versionId?: string) =>
    ['knowledge-zip', pageId ?? 'none', versionId ?? 'none'] as const,
  zipEntry: (pageId?: string, versionId?: string, path?: string | null) =>
    ['knowledge-zip-entry', pageId ?? 'none', versionId ?? 'none', path ?? 'none'] as const,
}
