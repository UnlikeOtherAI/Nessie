import type { ReactNode } from 'react'
import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { FinderAgentsColumn } from './FinderAgentsColumn'
import { FinderTreeSurface } from './FinderTreeSurface'

type FinderTreeDetailProps = {
  activePageId?: string
  agentDocumentsActive: boolean
  agentsDirectoryActive: boolean
  browseTo: (path: string[]) => void
  documentPane?: ReactNode
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
  onOpenAgent,
  onOpenDocument,
  pagePath,
  pagesQuery,
  root,
  rootQuery,
  rowsIn,
}: FinderTreeDetailProps) => {
  if (documentPane) return documentPane
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
  if (!agentDocumentsActive) return null
  return (
    <FinderTreeSurface
      activePageId={activePageId}
      browseTo={browseTo}
      onOpenDocument={onOpenDocument}
      pagePath={pagePath}
      query={pagesQuery}
      rowsIn={rowsIn}
    />
  )
}
