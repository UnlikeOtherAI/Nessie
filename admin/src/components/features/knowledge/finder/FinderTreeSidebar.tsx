import { useEffect, useState, type ReactNode } from 'react'
import { faClockRotateLeft, faFolder, faHouse, faLayerGroup, faRobot, faShareNodes } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeRoot } from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { SidebarTreeChevron, SidebarTreeChildren, SidebarTreeLeading, SidebarTreePanel, SidebarTreeSectionHeader } from '../../../primitives/SidebarTree'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { QueryState } from '../../../shared/QueryState'
import { ProjectAvatar } from '../../../primitives/ProjectAvatar'
import { FinderRow } from './FinderRow'
import { FinderTreeView } from './FinderTreeView'
import type { FinderRootRow } from './FinderRootColumn'

type FinderTreeSidebarProps = {
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
}

export const FinderTreeSidebar = ({
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
}: FinderTreeSidebarProps) => {
  const { token } = useAuthSession()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(
    () => new Set(selectedSpaceId ? [selectedSpaceId] : []),
  )

  useEffect(() => {
    if (!selectedSpaceId) return
    setExpandedSpaces((current) => new Set([...current, selectedSpaceId]))
  }, [selectedSpaceId])

  const rootRow = (row: FinderRootRow, title: string, icon: typeof faHouse, leading?: ReactNode) => (
    <FinderRow
      columnActive={false}
      icon={leading ? undefined : icon}
      iconTone="--accent"
      id={row.id}
      key={row.id}
      kind={row.kind === 'space' ? 'space' : 'virtual'}
      leading={leading}
      onOpen={() => {
        if (row.kind === 'space') {
          setExpandedSpaces((current) => {
            const next = new Set(current)
            if (next.has(row.space.spaceId)) next.delete(row.space.spaceId)
            else next.add(row.space.spaceId)
            return next
          })
        }
        onOpenRoot(row)
      }}
      selected={row.id === activeRootRowId}
      title={title}
      tree
      variant="root"
    />
  )
  const spaceRow = (row: FinderRootRow, title: string, icon: typeof faHouse) => {
    if (row.kind !== 'space') return null
    const expanded = expandedSpaces.has(row.space.spaceId) && row.space.spaceId === selectedSpaceId
    return (
      <div key={row.id}>
        {rootRow(row, title, icon, (
          <SidebarTreeLeading>
            <SidebarTreeChevron expanded={expanded} />
            {row.role === 'project' ? <ProjectAvatar size={20} token={token} />
              : <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" fixedWidth icon={icon} />}
          </SidebarTreeLeading>
        ))}
        {expanded ? (
          <QueryState
            className="knowledge-sidebar-tree-query py-2"
            errorLabel="Couldn’t load your documents."
            loadingLabel="Loading documents…"
            query={pagesQuery}
          >
            {() => (
              <FinderTreeView
                activePageId={activePageId}
                createFolderColumnKey={createFolderColumnKey}
                createFolderPending={createFolderPending}
                onCancelFolder={onCancelFolder}
                onOpenPage={(page, path) => {
                  if (page.kind === 'folder') return browseTo(path)
                  onOpenDocument(page, path)
                }}
                pagePath={pagePath}
                onSubmitFolder={onSubmitFolder}
                rowsIn={rowsIn}
                embedded
                rootColumnKey={`space:${row.space.spaceId}`}
              />
            )}
          </QueryState>
        ) : null}
      </div>
    )
  }

  const personal = root ? { id: root.myDocuments.spaceId, kind: 'space' as const, role: 'personal' as const, space: root.myDocuments } : null
  const projects = root?.projects ?? []
  const spaces = root?.shared ?? []

  return (
    <SidebarTreePanel className="knowledge-sidebar-tree-panel">
      <QueryState
        className="knowledge-sidebar-tree-query py-2"
        errorLabel="Couldn’t load your document spaces."
        loadingLabel="Loading documents…"
        query={rootQuery}
      >
        {() => root ? (
          <>
            <div className="space-y-0.5">
              {rootRow({ id: 'virtual:latest', kind: 'latest' }, 'Latest', faClockRotateLeft)}
              {rootRow(
                { count: root.sharedWithMeCount, id: 'virtual:shared', kind: 'shared-with-me' },
                'Shared with me',
                faShareNodes,
              )}
              {personal ? spaceRow(personal, 'My Documents', faHouse) : null}
            </div>
            <div className="mt-2.5">
              <SidebarTreeSectionHeader
                collapsed={Boolean(collapsed.projects)}
                controls="finder-projects"
                onToggle={() => setCollapsed((current) => ({ ...current, projects: !current.projects }))}
              >
                Projects
              </SidebarTreeSectionHeader>
              <SidebarTreeChildren id="finder-projects" className={collapsed.projects ? 'hidden' : ''}>
                {projects.map(({ space }) => spaceRow(
                  { id: space.spaceId, kind: 'space', role: 'project', space },
                  space.projectName ?? space.name,
                  faFolder,
                ))}
              </SidebarTreeChildren>
            </div>
            <div className="mt-3">
              {rootRow({ id: 'virtual:agents', kind: 'agents' }, 'Agents', faRobot)}
            </div>
            <div className="mt-3">
              <SidebarTreeSectionHeader
                collapsed={Boolean(collapsed.spaces)}
                controls="finder-spaces"
                onToggle={() => setCollapsed((current) => ({ ...current, spaces: !current.spaces }))}
              >
                Spaces
              </SidebarTreeSectionHeader>
              <SidebarTreeChildren id="finder-spaces" className={collapsed.spaces ? 'hidden' : ''}>
                {spaces.map((space) => spaceRow(
                  { id: space.spaceId, kind: 'space', role: 'shared', space },
                  space.name,
                  faLayerGroup,
                ))}
              </SidebarTreeChildren>
            </div>
          </>
        ) : null}
      </QueryState>
    </SidebarTreePanel>
  )
}
