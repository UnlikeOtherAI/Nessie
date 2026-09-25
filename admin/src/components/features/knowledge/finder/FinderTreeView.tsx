import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
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

const TreeItemIcon = ({ kind }: { kind: KnowledgePageRecord['kind'] }) => {
  if (kind === 'folder') {
    return (
      <svg aria-hidden="true" className="knowledge-tree-glyph" fill="none" viewBox="0 0 20 20">
        <path d="M2.75 5.5A1.75 1.75 0 0 1 4.5 3.75h3l1.5 1.5h6.5a1.75 1.75 0 0 1 1.75 1.75v7.5a1.75 1.75 0 0 1-1.75 1.75h-11a1.75 1.75 0 0 1-1.75-1.75v-9Z" />
      </svg>
    )
  }
  if (kind === 'spreadsheet') {
    return (
      <svg aria-hidden="true" className="knowledge-tree-glyph" fill="none" viewBox="0 0 20 20">
        <rect height="14" rx="1.75" width="13" x="3.5" y="3" />
        <path d="M3.5 7.5h13M8 7.5v9M12.5 7.5v9M3.5 12h13" />
      </svg>
    )
  }
  return (
    <svg aria-hidden="true" className="knowledge-tree-glyph" fill="none" viewBox="0 0 20 20">
      <path d="M5 2.75h6l4 4v10.5H5V2.75Z" />
      <path d="M11 2.75v4h4M7.5 10h5M7.5 13h5" />
    </svg>
  )
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
                  <TreeItemIcon kind={page.kind} />
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
              tree
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
