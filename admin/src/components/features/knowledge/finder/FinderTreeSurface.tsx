import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { EmptyState } from '../../../shared/EmptyState'
import { QueryState } from '../../../shared/QueryState'
import { FinderTreeView } from './FinderTreeView'

type FinderTreeSurfaceProps = {
  activePageId?: string
  browseTo: (path: string[]) => void
  onOpenDocument: (page: KnowledgePageRecord, path: string[]) => void
  pagePath: string[]
  query: {
    isError: boolean
    isLoading: boolean
    refetch: () => unknown
  }
  rowsIn: (parentPageId: string | null) => KnowledgePageRecord[]
}

export const FinderTreeSurface = ({
  activePageId,
  browseTo,
  onOpenDocument,
  pagePath,
  query,
  rowsIn,
}: FinderTreeSurfaceProps) => (
  <QueryState
    className="knowledge-sidebar-tree-query py-6"
    errorLabel="Couldn’t load your documents."
    loadingLabel="Loading documents…"
    query={query}
  >
    {() => rowsIn(null).length === 0 ? <EmptyState className="mt-2">Nothing here yet.</EmptyState> : (
      <FinderTreeView
        activePageId={activePageId}
        onOpenPage={(page, path) => {
          if (page.kind === 'folder') return browseTo(path)
          onOpenDocument(page, path)
        }}
        pagePath={pagePath}
        rowsIn={rowsIn}
      />
    )}
  </QueryState>
)
