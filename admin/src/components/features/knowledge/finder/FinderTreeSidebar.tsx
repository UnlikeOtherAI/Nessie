import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Folder, History, House, Layers3, Share2, type LucideIcon } from 'lucide-react'
import type { KnowledgeRoot } from '@nessie/schemas'
import type { KnowledgeRootSpace } from '@nessie/schemas'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { SidebarTreeChevron, SidebarTreeChildren, SidebarTreeLeading, SidebarTreePanel, SidebarTreeSectionHeader } from '../../../primitives/SidebarTree'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { QueryState } from '../../../shared/QueryState'
import { ProjectAvatar } from '../../../primitives/ProjectAvatar'
import { FinderRow } from './FinderRow'
import { FinderTreeView } from './FinderTreeView'
import { agentDocumentsSpaceDisplayName } from './agent-space-name'
import { AgentAvatar } from '../../../shared/AgentAvatar'
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
  onOpenAgent: (space: KnowledgeRootSpace) => void
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
  onOpenAgent,
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

  const treeIcon = (icon: LucideIcon) => {
    const Icon = icon
    return <Icon aria-hidden="true" className="h-4 w-4 text-[color:var(--tx3)]" strokeWidth={1.8} />
  }
  const rootRow = (row: FinderRootRow, title: string, icon: ReactNode, leading?: ReactNode) => (
    <FinderRow
      columnActive={false}
      id={row.id}
      key={row.id}
      kind={row.kind === 'space' ? 'space' : 'virtual'}
      leading={leading ?? <SidebarTreeLeading>{icon}</SidebarTreeLeading>}
      onOpen={() => {
        if (row.kind === 'space') {
          // Selecting a root opens it; it must not turn into a collapse toggle
          // on the very next click. Child folders have their own chevrons.
          setExpandedSpaces((current) => new Set([...current, row.space.spaceId]))
        }
        onOpenRoot(row)
      }}
      selected={row.id === activeRootRowId}
      title={title}
      tree
      variant="root"
    />
  )
  const spaceRow = (row: FinderRootRow, title: string, icon: ReactNode) => {
    if (row.kind !== 'space') return null
    const expanded = expandedSpaces.has(row.space.spaceId) && row.space.spaceId === selectedSpaceId
    return (
      <div key={row.id}>
        {rootRow(row, title, icon, (
          <SidebarTreeLeading>
            <SidebarTreeChevron expanded={expanded} />
            {row.role === 'project' ? <ProjectAvatar size={20} token={token} />
              : icon}
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
  const agentsExpanded = activeRootRowId === 'virtual:agents'

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
              {rootRow({ id: 'virtual:latest', kind: 'latest' }, 'Latest', treeIcon(History))}
              {rootRow(
                { count: root.sharedWithMeCount, id: 'virtual:shared', kind: 'shared-with-me' },
                'Shared with me',
                treeIcon(Share2),
              )}
              {personal ? spaceRow(personal, 'My Documents', treeIcon(House)) : null}
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
                  treeIcon(Folder),
                ))}
              </SidebarTreeChildren>
            </div>
            <div className="mt-3">
              {rootRow({ id: 'virtual:agents', kind: 'agents' }, 'Agents', treeIcon(Bot), (
                <SidebarTreeLeading>
                  <SidebarTreeChevron expanded={agentsExpanded} />
                  {treeIcon(Bot)}
                </SidebarTreeLeading>
              ))}
              {agentsExpanded ? (
                <SidebarTreeChildren className="sidebar-tree-depth">
                  {(root.agentHomes ?? []).map((space) => {
                    const agentId = space.ownerAgentId
                    if (!agentId) return null
                    const expanded = selectedSpaceId === space.spaceId
                    return (
                      <div key={space.spaceId}>
                        <FinderRow
                          id={space.spaceId}
                          kind="space"
                          leading={(
                            <SidebarTreeLeading>
                              <SidebarTreeChevron expanded={expanded} />
                              <AgentAvatar agentId={agentId} size={20} token={token} />
                            </SidebarTreeLeading>
                          )}
                          onOpen={() => onOpenAgent(space)}
                          selected={expanded}
                          title={agentDocumentsSpaceDisplayName(space.name)}
                          tree
                          variant="item"
                        />
                        {expanded ? (
                          <QueryState
                            className="knowledge-sidebar-tree-query py-2"
                            errorLabel="Couldn’t load agent documents."
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
                                onSubmitFolder={onSubmitFolder}
                                pagePath={pagePath}
                                rowsIn={rowsIn}
                                rootColumnKey={`space:${space.spaceId}`}
                              />
                            )}
                          </QueryState>
                        ) : null}
                      </div>
                    )
                  })}
                  {root.agentHomesTruncated ? (
                    <p className="px-3 py-2 text-xs text-[color:var(--tx3)]">
                      Showing the first 200 accessible agents.
                    </p>
                  ) : null}
                </SidebarTreeChildren>
              ) : null}
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
                  treeIcon(Layers3),
                ))}
              </SidebarTreeChildren>
            </div>
          </>
        ) : null}
      </QueryState>
    </SidebarTreePanel>
  )
}
