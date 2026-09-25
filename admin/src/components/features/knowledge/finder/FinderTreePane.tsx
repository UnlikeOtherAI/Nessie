import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import type { FinderRootRow } from './FinderRootColumn'
import type { ReactNode } from 'react'
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
  agentDocumentsActive?: boolean
  agentsDirectoryActive?: boolean
  documentPane?: ReactNode
  onOpenAgent: (space: KnowledgeRootSpace) => void
  virtualListing?: Parameters<typeof FinderTreeVirtualDetail>[0]
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
  agentDocumentsActive = false,
  agentsDirectoryActive = false,
  documentPane,
  onOpenAgent,
  virtualListing,
}: FinderTreePaneProps) => (
  <div className="flex min-w-0 flex-1">
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
      pagePath={pagePath}
      pagesQuery={pagesQuery}
      root={root}
      rootQuery={rootQuery}
      rowsIn={rowsIn}
      selectedSpaceId={selectedSpaceId}
    />
    <div className="min-w-0 flex-1 border-l border-[color:var(--sep)] bg-[color:var(--main)]">
      <FinderTreeDetail
        activePageId={activePageId}
        agentDocumentsActive={agentDocumentsActive}
        agentsDirectoryActive={agentsDirectoryActive}
        browseTo={browseTo}
        documentPane={documentPane}
        onOpenAgent={onOpenAgent}
        onOpenDocument={onOpenDocument}
        pagePath={pagePath}
        pagesQuery={pagesQuery}
        root={root}
        rootQuery={rootQuery}
        rowsIn={rowsIn}
        virtualContent={virtualListing ? <FinderTreeVirtualDetail {...virtualListing} /> : undefined}
      />
    </div>
  </div>
)
