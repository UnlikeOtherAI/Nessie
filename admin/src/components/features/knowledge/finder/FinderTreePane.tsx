import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import type { FinderRootRow } from './FinderRootColumn'
import { useState, type ReactNode } from 'react'
import { getStoredJson, setStoredJson } from '../../../../lib/storage'
import { BrowserColumnResizeHandle } from '../../../shared/column-browser/ColumnBrowserColumn'
import { FinderTreeDetail } from './FinderTreeDetail'
import { FinderTreeSidebar } from './FinderTreeSidebar'
import { FinderTreeVirtualDetail } from './FinderTreeVirtualDetail'

type FinderTreePaneProps = {
  activePageId?: string
  activeRootRowId?: string
  browseTo: (path: string[]) => void
  createFolderColumnKey: string | null
  createFolderPending: boolean
  onCancelFolder: () => void
  onSubmitFolder: (name: string) => void
  onOpenDocument: (page: KnowledgePageRecord, path: string[]) => void
  onOpenRoot: (row: FinderRootRow) => void
  pagePath: string[]
  pagesQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  root?: KnowledgeRoot
  rootQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  rowsIn: (parentPageId: string | null) => KnowledgePageRecord[]
  selectedSpaceId?: string
  documentPane?: ReactNode
  onOpenAgent: (space: KnowledgeRootSpace) => void
  virtualListing?: Parameters<typeof FinderTreeVirtualDetail>[0]
}

const TREE_WIDTH_KEY = 'nessie.admin.knowledgeTreeWidth'
const DEFAULT_TREE_WIDTH = 280
const MIN_TREE_WIDTH = 240
const MAX_TREE_WIDTH = 720

const clampTreeWidth = (width: number): number =>
  Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, width))

const initialTreeWidth = (): number => {
  const stored = getStoredJson(TREE_WIDTH_KEY)
  return typeof stored === 'number' && Number.isFinite(stored)
    ? clampTreeWidth(stored)
    : DEFAULT_TREE_WIDTH
}

export const FinderTreePane = ({
  activePageId,
  activeRootRowId,
  browseTo,
  createFolderColumnKey,
  createFolderPending,
  onCancelFolder,
  onSubmitFolder,
  onOpenDocument,
  onOpenRoot,
  pagePath,
  pagesQuery,
  root,
  rootQuery,
  rowsIn,
  selectedSpaceId,
  documentPane,
  onOpenAgent,
  virtualListing,
}: FinderTreePaneProps) => {
  const [width, setWidth] = useState(initialTreeWidth)

  return (
    <div className="flex min-w-0 flex-1" data-knowledge-tree-pane>
      <div className="relative h-full flex-shrink-0" style={{ width }}>
        <FinderTreeSidebar
          activePageId={activePageId}
          activeRootRowId={activeRootRowId}
          browseTo={browseTo}
          createFolderColumnKey={createFolderColumnKey}
          createFolderPending={createFolderPending}
          onCancelFolder={onCancelFolder}
          onSubmitFolder={onSubmitFolder}
          onOpenDocument={onOpenDocument}
          onOpenRoot={onOpenRoot}
          onOpenAgent={onOpenAgent}
          pagePath={pagePath}
          pagesQuery={pagesQuery}
          root={root}
          rootQuery={rootQuery}
          rowsIn={rowsIn}
          selectedSpaceId={selectedSpaceId}
        />
        <BrowserColumnResizeHandle
          max={MAX_TREE_WIDTH}
          min={MIN_TREE_WIDTH}
          onResize={(next, commit) => {
            setWidth(next)
            if (commit) setStoredJson(TREE_WIDTH_KEY, next)
          }}
          width={width}
        />
      </div>
      <div className="min-w-0 flex-1 border-l border-[color:var(--sep)] bg-[color:var(--main)]">
        <FinderTreeDetail
          documentPane={documentPane}
          virtualContent={virtualListing ? <FinderTreeVirtualDetail {...virtualListing} /> : undefined}
        />
      </div>
    </div>
  )
}
