import { useEffect, useState, type ReactNode } from 'react'
import { faFile, faFileLines, faFolder } from '@fortawesome/free-solid-svg-icons'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { SidebarTreeChevron, SidebarTreeChildren, SidebarTreeLeading, SidebarTreeNode, SidebarTreePanel } from '../../../primitives/SidebarTree'
import { FinderRow } from './FinderRow'
import { NewFolderRow } from './NewFolderRow'

type FinderTreeViewProps = {
  activePageId?: string
  createFolderColumnKey?: string | null
  createFolderPending?: boolean
  onCancelFolder?: () => void
  rowsIn: (parentPageId: string | null) => KnowledgePageRecord[]
  onOpenPage: (page: KnowledgePageRecord, path: string[]) => void
  onSubmitFolder?: (name: string) => void
  pagePath: string[]
  rootColumnKey?: string
  embedded?: boolean
}

export const FinderTreeView = ({
  activePageId,
  createFolderColumnKey,
  createFolderPending,
  onCancelFolder,
  onOpenPage,
  onSubmitFolder,
  pagePath,
  rootColumnKey,
  rowsIn,
  embedded = false,
}: FinderTreeViewProps) => {
  const [expandedPages, setExpandedPages] = useState<Set<string>>(() => new Set())
  const selectedPageId = activePageId ?? pagePath.at(-1)

  useEffect(() => {
    setExpandedPages((current) => new Set([...current, ...pagePath]))
  }, [pagePath])

  const toggle = (id: string) => {
    setExpandedPages((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderPages = (pages: KnowledgePageRecord[], parentPath: string[], depth: number): ReactNode => (
    <SidebarTreeChildren className={depth > 0 ? 'sidebar-tree-depth' : ''}>
      {onCancelFolder && onSubmitFolder
        && createFolderColumnKey === (parentPath.at(-1) ? `folder:${parentPath.at(-1)}` : rootColumnKey) ? (
        <NewFolderRow
          onCancel={onCancelFolder}
          onSubmit={onSubmitFolder}
          pending={createFolderPending ?? false}
        />
      ) : null}
      {pages.map((page) => {
        const path = [...parentPath, page.id]
        const children = rowsIn(page.id)
        const open = expandedPages.has(page.id)
        return (
          <SidebarTreeNode key={page.id}>
            <FinderRow
              leading={(
                <SidebarTreeLeading>
                  {children.length > 0 ? <SidebarTreeChevron expanded={open} /> : <span className="h-2.5 w-2.5 shrink-0" />}
                  <FontAwesomeIcon
                    className="h-3.5 w-3.5 text-[color:var(--tx3)]"
                    fixedWidth
                    icon={page.kind === 'document' ? faFileLines : page.kind === 'folder' ? faFolder : faFile}
                  />
                </SidebarTreeLeading>
              )}
              id={page.id}
              kind={page.kind}
              onOpen={() => {
                if (children.length > 0) {
                  toggle(page.id)
                  if (page.id === selectedPageId) return
                }
                onOpenPage(page, path)
              }}
              selected={page.id === selectedPageId}
              title={page.title}
              variant="item"
            />
            {children.length > 0 && open ? renderPages(children, path, depth + 1) : null}
          </SidebarTreeNode>
        )
      })}
    </SidebarTreeChildren>
  )

  return embedded
    ? <SidebarTreeChildren className="sidebar-tree-depth">{renderPages(rowsIn(null), [], 0)}</SidebarTreeChildren>
    : <SidebarTreePanel className="knowledge-sidebar-tree-panel h-full">{renderPages(rowsIn(null), [], 0)}</SidebarTreePanel>
}
