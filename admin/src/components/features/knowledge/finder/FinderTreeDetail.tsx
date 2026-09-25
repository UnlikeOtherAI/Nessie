import type { ReactNode } from 'react'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { EmptyState } from '../../../shared/EmptyState'
import { FinderAgentsColumn } from './FinderAgentsColumn'
import { FinderTreeSurface } from './FinderTreeSurface'

type FinderTreeDetailProps = {
  activePageId?: string
  agentDocumentsActive: boolean
  agentsDirectoryActive: boolean
  browseTo: (path: string[]) => void
  documentPane?: ReactNode
  virtualContent?: ReactNode
  onOpenAgent: (space: KnowledgeRootSpace) => void
  onOpenDocument: (page: KnowledgePageRecord, path: string[]) => void
  pagePath: string[]
  pagesQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  root?: KnowledgeRoot
  rootQuery: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  rowsIn: (parentPageId: string | null) => KnowledgePageRecord[]
}

/** Content beside the hierarchy; changing it must never switch the active view. */
export const FinderTreeDetail = ({
  activePageId,
  agentDocumentsActive,
  agentsDirectoryActive,
  browseTo,
  documentPane,
  virtualContent,
  onOpenAgent,
  onOpenDocument,
  pagePath,
  pagesQuery,
  root,
  rootQuery,
  rowsIn,
}: FinderTreeDetailProps) => {
  if (documentPane) return documentPane
  if (virtualContent) return virtualContent
  if (agentsDirectoryActive) {
    return (
      <div className="h-full overflow-y-auto px-3 py-2">
        <FinderAgentsColumn
          activeAgentId={undefined}
          columnActive
          onOpen={onOpenAgent}
          query={rootQuery}
          root={root}
        />
      </div>
    )
  }
  const renderSurface = (parentPageId: string | null = null, emptyLabel?: string) => (
    <FinderTreeSurface
      activePageId={activePageId}
      browseTo={browseTo}
      emptyLabel={emptyLabel}
      onOpenDocument={onOpenDocument}
      pagePath={pagePath}
      basePath={parentPageId ? pagePath : []}
      parentPageId={parentPageId}
      query={pagesQuery}
      rowsIn={rowsIn}
    />
  )
  const selectedFolderId = pagePath.at(-1)
  if (selectedFolderId) return renderSurface(selectedFolderId, 'This folder is empty.')
  if (!agentDocumentsActive) {
    return (
      <div className="flex h-full items-start justify-center p-6">
        <EmptyState className="max-w-lg">
          Select a folder or document to see its contents here.
        </EmptyState>
      </div>
    )
  }
  return renderSurface()
}
