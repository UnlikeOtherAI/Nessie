import { useEffect, useMemo, useState } from 'react'
import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../../shared/column-browser/ColumnBrowserViewport'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import {
  EmptyFolder,
  KnowledgeBreadcrumb,
  KnowledgeItemRow,
  type KnowledgeFilesystemItemKind,
} from './KnowledgeFilesystemRows'
import type { KnowledgeViewMode } from './KnowledgeViewToggle'

type KnowledgeFilesystemBrowserProps = {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  mode: KnowledgeViewMode
  onBrowsePath: (path: string[]) => void
  onOpenDocumentPath: (path: string[]) => void
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  pagePath: string[]
  pages: KnowledgePageRecord[]
  rootPages: KnowledgePageRecord[]
  selectedSpaceId?: string
  selectedSpaceName: string
}

const pageKind = (
  page: KnowledgePageRecord,
  childrenOf: (parentPageId: string) => KnowledgePageRecord[],
): KnowledgeFilesystemItemKind => (childrenOf(page.id).length > 0 ? 'folder' : 'file')

const sortFilesystemPages = (
  pages: KnowledgePageRecord[],
  childrenOf: (parentPageId: string) => KnowledgePageRecord[],
): KnowledgePageRecord[] =>
  [...pages].sort((left, right) => {
    const leftFolder = pageKind(left, childrenOf) === 'folder'
    const rightFolder = pageKind(right, childrenOf) === 'folder'
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1
    return left.position - right.position || left.title.localeCompare(right.title)
  })

const FullPageView = ({
  childrenOf,
  onBrowsePath,
  onOpenDocumentPath,
  pathPages,
  rootPages,
  selectedSpaceName,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  onBrowsePath: (path: string[]) => void
  onOpenDocumentPath: (path: string[]) => void
  pathPages: KnowledgePageRecord[]
  rootPages: KnowledgePageRecord[]
  selectedSpaceName: string
}) => {
  const currentFolder = pathPages.at(-1)
  const currentPath = pathPages.map((page) => page.id)
  const items = sortFilesystemPages(
    currentFolder ? childrenOf(currentFolder.id) : rootPages,
    childrenOf,
  )

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="animate-kb-view-slide px-4 py-4">
        <div className="mb-3 flex min-h-8 items-center border-b border-[color:var(--sep)] pb-3">
          <KnowledgeBreadcrumb
            onBrowsePath={onBrowsePath}
            pathPages={pathPages}
            rootLabel={selectedSpaceName}
          />
        </div>
        {items.length === 0 ? (
          <EmptyFolder label="No files in this folder." />
        ) : (
          <div className="grid gap-0.5">
            {items.map((page) => {
              const children = childrenOf(page.id)
              const kind = children.length > 0 ? 'folder' : 'file'
              const path = [...currentPath, page.id]
              return (
                <KnowledgeItemRow
                  childCount={children.length}
                  isSelected={kind === 'folder' && currentPath.at(-1) === page.id}
                  key={page.id}
                  kind={kind}
                  onClick={() => {
                    if (kind === 'folder') {
                      onBrowsePath(path)
                      return
                    }
                    onOpenDocumentPath(path)
                  }}
                  page={page}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const ColumnPageList = ({
  childrenOf,
  emptyLabel,
  onBrowsePath,
  onOpenDocumentPath,
  pages,
  pathPrefix,
  selectedId,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  emptyLabel: string
  onBrowsePath: (path: string[]) => void
  onOpenDocumentPath: (path: string[]) => void
  pages: KnowledgePageRecord[]
  pathPrefix: string[]
  selectedId?: string
}) => {
  const items = sortFilesystemPages(pages, childrenOf)

  if (items.length === 0) {
    return <EmptyFolder label={emptyLabel} />
  }

  return (
    <div className="grid gap-0.5">
      {items.map((page) => {
        const children = childrenOf(page.id)
        const kind = children.length > 0 ? 'folder' : 'file'
        const path = [...pathPrefix, page.id]
        return (
          <KnowledgeItemRow
            childCount={children.length}
            isSelected={selectedId === page.id}
            key={page.id}
            kind={kind}
            onClick={() => {
              if (kind === 'folder') {
                onBrowsePath(path)
                return
              }
              onOpenDocumentPath(path)
            }}
            page={page}
            trailing={
              kind === 'folder' ? (
                <FontAwesomeIcon
                  className="h-3 w-3 shrink-0 text-[color:var(--tx3)]"
                  icon={faChevronRight}
                />
              ) : null
            }
          />
        )
      })}
    </div>
  )
}

const ColumnView = ({
  childrenOf,
  onBrowsePath,
  onOpenDocumentPath,
  pathPages,
  rootPages,
  selectedSpaceName,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  onBrowsePath: (path: string[]) => void
  onOpenDocumentPath: (path: string[]) => void
  pathPages: KnowledgePageRecord[]
  rootPages: KnowledgePageRecord[]
  selectedSpaceName: string
}) => {
  const columns = [
    <ColumnBrowserColumn key="root" title={selectedSpaceName}>
      <ColumnPageList
        childrenOf={childrenOf}
        emptyLabel="No pages yet."
        onBrowsePath={onBrowsePath}
        onOpenDocumentPath={onOpenDocumentPath}
        pages={rootPages}
        pathPrefix={[]}
        selectedId={pathPages[0]?.id}
      />
    </ColumnBrowserColumn>,
  ]

  pathPages.forEach((folder, index) => {
    columns.push(
      <ColumnBrowserColumn key={folder.id} title={folder.title}>
        <ColumnPageList
          childrenOf={childrenOf}
          emptyLabel="No files in this folder."
          onBrowsePath={onBrowsePath}
          onOpenDocumentPath={onOpenDocumentPath}
          pages={childrenOf(folder.id)}
          pathPrefix={pathPages.slice(0, index + 1).map((page) => page.id)}
          selectedId={pathPages[index + 1]?.id}
        />
      </ColumnBrowserColumn>,
    )
  })

  return (
    <div className="h-full w-full animate-kb-view-slide">
      <ColumnBrowserViewport activeColumn={columns.length - 1} columns={columns} />
    </div>
  )
}

const TreeNode = ({
  childrenOf,
  depth,
  expandedIds,
  onBrowsePath,
  onOpenDocumentPath,
  page,
  path,
  selectedFolderId,
  toggleExpanded,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  depth: number
  expandedIds: Set<string>
  onBrowsePath: (path: string[]) => void
  onOpenDocumentPath: (path: string[]) => void
  page: KnowledgePageRecord
  path: string[]
  selectedFolderId?: string
  toggleExpanded: (pageId: string) => void
}) => {
  const children = childrenOf(page.id)
  const kind = children.length > 0 ? 'folder' : 'file'
  const isExpanded = expandedIds.has(page.id)
  const childItems = sortFilesystemPages(children, childrenOf)

  return (
    <div>
      <KnowledgeItemRow
        childCount={children.length}
        depth={depth}
        isExpanded={isExpanded}
        isSelected={kind === 'folder' && selectedFolderId === page.id}
        kind={kind}
        onClick={() => {
          if (kind === 'folder') {
            toggleExpanded(page.id)
            onBrowsePath(path)
            return
          }
          onOpenDocumentPath(path)
        }}
        page={page}
      />
      {kind === 'folder' ? (
        <div
          className={[
            'grid transition-[grid-template-rows] duration-200 ease-out',
            isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          ].join(' ')}
        >
          <div className="min-h-0 overflow-hidden">
            {childItems.map((child) => (
              <TreeNode
                childrenOf={childrenOf}
                depth={depth + 1}
                expandedIds={expandedIds}
                key={child.id}
                onBrowsePath={onBrowsePath}
                onOpenDocumentPath={onOpenDocumentPath}
                page={child}
                path={[...path, child.id]}
                selectedFolderId={selectedFolderId}
                toggleExpanded={toggleExpanded}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

const TreeView = ({
  childrenOf,
  expandedIds,
  onBrowsePath,
  onOpenDocumentPath,
  rootPages,
  selectedFolderId,
  toggleExpanded,
}: {
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  expandedIds: Set<string>
  onBrowsePath: (path: string[]) => void
  onOpenDocumentPath: (path: string[]) => void
  rootPages: KnowledgePageRecord[]
  selectedFolderId?: string
  toggleExpanded: (pageId: string) => void
}) => {
  const items = sortFilesystemPages(rootPages, childrenOf)

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="animate-kb-view-slide px-4 py-4">
        {items.length === 0 ? (
          <EmptyFolder label="No pages yet." />
        ) : (
          <div className="grid gap-0.5">
            {items.map((page) => (
              <TreeNode
                childrenOf={childrenOf}
                depth={0}
                expandedIds={expandedIds}
                key={page.id}
                onBrowsePath={onBrowsePath}
                onOpenDocumentPath={onOpenDocumentPath}
                page={page}
                path={[page.id]}
                selectedFolderId={selectedFolderId}
                toggleExpanded={toggleExpanded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export const KnowledgeFilesystemBrowser = ({
  childrenOf,
  mode,
  onBrowsePath,
  onOpenDocumentPath,
  pageById,
  pagePath,
  pages,
  rootPages,
  selectedSpaceId,
  selectedSpaceName,
}: KnowledgeFilesystemBrowserProps) => {
  const pathPages = pagePath
    .map((pageId) => pageById(pageId))
    .filter((page): page is KnowledgePageRecord => Boolean(page))
  const selectedFolderId = pathPages.at(-1)?.id
  const folderIds = useMemo(
    () => pages.filter((page) => childrenOf(page.id).length > 0).map((page) => page.id),
    [childrenOf, pages],
  )
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [primedSpaceId, setPrimedSpaceId] = useState<string | undefined>()

  useEffect(() => {
    if (mode !== 'tree' || primedSpaceId === selectedSpaceId) return
    setExpandedIds(new Set(folderIds))
    setPrimedSpaceId(selectedSpaceId)
  }, [folderIds, mode, primedSpaceId, selectedSpaceId])

  useEffect(() => {
    if (pagePath.length === 0) return
    setExpandedIds((current) => {
      const next = new Set(current)
      for (const pageId of pagePath) next.add(pageId)
      return next
    })
  }, [pagePath])

  const toggleExpanded = (pageId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(pageId)) {
        next.delete(pageId)
      } else {
        next.add(pageId)
      }
      return next
    })
  }

  if (mode === 'full') {
    return (
      <FullPageView
        childrenOf={childrenOf}
        onBrowsePath={onBrowsePath}
        onOpenDocumentPath={onOpenDocumentPath}
        pathPages={pathPages}
        rootPages={rootPages}
        selectedSpaceName={selectedSpaceName}
      />
    )
  }

  if (mode === 'tree') {
    return (
      <TreeView
        childrenOf={childrenOf}
        expandedIds={expandedIds}
        onBrowsePath={onBrowsePath}
        onOpenDocumentPath={onOpenDocumentPath}
        rootPages={rootPages}
        selectedFolderId={selectedFolderId}
        toggleExpanded={toggleExpanded}
      />
    )
  }

  return (
    <ColumnView
      childrenOf={childrenOf}
      onBrowsePath={onBrowsePath}
      onOpenDocumentPath={onOpenDocumentPath}
      pathPages={pathPages}
      rootPages={rootPages}
      selectedSpaceName={selectedSpaceName}
    />
  )
}
