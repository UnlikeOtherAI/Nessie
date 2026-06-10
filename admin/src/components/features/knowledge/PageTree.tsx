import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'

type PageTreeProps = {
  onCreateChild: (parentPageId: string | null) => void
  onSelectPage: (pageId: string) => void
  pages: KnowledgePageRecord[]
  selectedPageId?: string
}

const statusTone: Record<KnowledgePageRecord['status'], string> = {
  draft: 'text-[var(--warning-text)]',
  published: 'text-[var(--success-text)]',
  archived: 'text-[color:var(--tx3)]',
}

const TreeRow = ({
  depth,
  onCreateChild,
  onSelectPage,
  page,
  pagesByParent,
  selectedPageId,
}: {
  depth: number
  onCreateChild: (parentPageId: string | null) => void
  onSelectPage: (pageId: string) => void
  page: KnowledgePageRecord
  pagesByParent: Map<string | null, KnowledgePageRecord[]>
  selectedPageId?: string
}) => {
  const children = pagesByParent.get(page.id) ?? []
  const active = page.id === selectedPageId

  return (
    <div>
      <div className="group flex items-center gap-1">
        <button
          className={[
            'min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm',
            active
              ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
              : 'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
          ].join(' ')}
          onClick={() => onSelectPage(page.id)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          type="button"
        >
          <span className="block truncate">{page.title}</span>
          <span className={`text-[10px] uppercase tracking-[0.14em] ${statusTone[page.status]}`}>
            {page.status}
          </span>
        </button>
        <button
          aria-label={`Create child page under ${page.title}`}
          className={[
            'hidden h-7 w-7 flex-shrink-0 items-center justify-center rounded',
            'text-[color:var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)] group-hover:flex',
          ].join(' ')}
          onClick={() => onCreateChild(page.id)}
          type="button"
        >
          +
        </button>
      </div>
      {children.map((child) => (
        <TreeRow
          depth={depth + 1}
          key={child.id}
          onCreateChild={onCreateChild}
          onSelectPage={onSelectPage}
          page={child}
          pagesByParent={pagesByParent}
          selectedPageId={selectedPageId}
        />
      ))}
    </div>
  )
}

export const PageTree = ({
  onCreateChild,
  onSelectPage,
  pages,
  selectedPageId,
}: PageTreeProps) => {
  const pagesByParent = new Map<string | null, KnowledgePageRecord[]>()
  for (const page of pages) {
    const key = page.parentPageId ?? null
    pagesByParent.set(key, [...(pagesByParent.get(key) ?? []), page])
  }

  const rootPages = pagesByParent.get(null) ?? []

  return (
    <div className="grid gap-1">
      {rootPages.map((page) => (
        <TreeRow
          depth={0}
          key={page.id}
          onCreateChild={onCreateChild}
          onSelectPage={onSelectPage}
          page={page}
          pagesByParent={pagesByParent}
          selectedPageId={selectedPageId}
        />
      ))}
      {rootPages.length === 0 ? (
        <div className="px-2 py-8 text-center text-sm text-[color:var(--tx3)]">
          No pages yet
        </div>
      ) : null}
    </div>
  )
}
