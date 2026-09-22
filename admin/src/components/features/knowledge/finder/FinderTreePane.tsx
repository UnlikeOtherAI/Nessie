import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { KnowledgeRoot } from '@nessie/schemas'
import type { FinderRootRow } from './FinderRootColumn'
import { FinderTreeSidebar } from './FinderTreeSidebar'

type FinderTreePaneProps = {
  activePageId?: string
  browseTo: (path: string[]) => void
  onOpenDocument: (page: KnowledgePageRecord, path: string[]) => void
  onOpenRoot: (row: FinderRootRow) => void
  pagePath: string[]
  pagesQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  root?: KnowledgeRoot
  rootQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  rowsIn: (parentPageId: string | null) => KnowledgePageRecord[]
  selectedSpaceId?: string
}

export const FinderTreePane = ({
  activePageId,
  browseTo,
  onOpenDocument,
  onOpenRoot,
  pagePath,
  pagesQuery,
  root,
  rootQuery,
  rowsIn,
  selectedSpaceId,
}: FinderTreePaneProps) => (
  <div className="flex min-w-0 flex-1">
    <FinderTreeSidebar
      activePageId={activePageId}
      browseTo={browseTo}
      onOpenDocument={onOpenDocument}
      onOpenRoot={onOpenRoot}
      pagePath={pagePath}
      pagesQuery={pagesQuery}
      root={root}
      rootQuery={rootQuery}
      rowsIn={rowsIn}
      selectedSpaceId={selectedSpaceId}
    />
    <div className="min-w-0 flex-1" />
  </div>
)
