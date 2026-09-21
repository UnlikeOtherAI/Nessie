import type { ReactNode } from 'react'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { FinderTreeSurface } from './FinderTreeSurface'

type FinderTreePaneProps = {
  activePageId?: string
  browseTo: (path: string[]) => void
  onOpenDocument: (page: KnowledgePageRecord, path: string[]) => void
  pagePath: string[]
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  rootColumn?: ReactNode
  rootColumnWidth?: number
  rowsIn: (parentPageId: string | null) => KnowledgePageRecord[]
}

export const FinderTreePane = ({
  activePageId,
  browseTo,
  onOpenDocument,
  pagePath,
  query,
  rootColumn,
  rootColumnWidth,
  rowsIn,
}: FinderTreePaneProps) => (
  <>
    {rootColumn ? (
      <div className="h-full flex-shrink-0" style={{ width: rootColumnWidth }}>
        {rootColumn}
      </div>
    ) : null}
    <FinderTreeSurface
      activePageId={activePageId}
      browseTo={browseTo}
      onOpenDocument={onOpenDocument}
      pagePath={pagePath}
      query={query}
      rowsIn={rowsIn}
    />
  </>
)
