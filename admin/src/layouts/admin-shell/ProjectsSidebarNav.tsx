import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAttentionSummary } from '../../facades/alerts/hooks'
import { useProjectBoards, type BoardRecord } from '../../facades/boards/hooks'
import { useDeleteProject, useProjects } from '../../facades/projects/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { getCookie, setCookie } from '../../lib/storage'
import { isReactNativeWebView } from '../../lib/native-shell'
import { usePhoneLayout } from '../../navigation/mobile-shell'
import { projectSectionIdFromPathname } from '../../navigation/project-sections'
import { useToasts } from '../../providers/ToastProvider'
import { ProjectRow } from './ProjectRow'
import { ProjectsNavDialogs } from './ProjectsNavDialogs'
import type { ProjectListId } from './ProjectSectionRows'
import {
  parseExpandedProjectIds,
  retainExpandedProjectIds,
  serializeExpandedProjectIds,
} from './projects-nav-expansion'
import { SidebarEmptyNote } from './SidebarEmptyNote'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'
import type { StarredItem } from './types'

type ProjectsSidebarNavProps = {
  isOwner: boolean
  onToggleStar: (type: StarredItem['type'], id: string) => void
  pathname: string
  starredCollapsed: boolean
  starredProjectIds: Set<string>
  toggleStarredCollapsed: () => void
}

type ProjectNavSectionId = 'projects'

const PROJECT_NAV_SECTION_IDS: ProjectNavSectionId[] = ['projects']

const projectNavCookieName = (id: ProjectNavSectionId) => `projectsNavCollapsed-${id}`

// Every open/closed state of this menu is remembered, so the tree a person
// left behind is the tree they come back to: the two section headers through
// `useCookieBackedSidebarSections` and the shell's `starredCollapsed`, and
// these two id sets — which projects have their sections open, and which
// projects have the boards inside their Board section *closed*.
//
// The two default opposite ways round on purpose. A project's sections are
// closed until asked for, but its boards are open: this list is the only
// doorway to a board that is not the project's default — the project header
// carries no board strip — so a project whose second board nobody can see is
// a board nobody can reach (AGENTS.md → "Rule zero").
const EXPANDED_PROJECT_IDS_COOKIE = 'projectsNavExpandedIds'
const COLLAPSED_BOARD_PROJECT_IDS_COOKIE = 'projectsNavCollapsedBoardIds'

/** The project a projects-section pathname is standing in, if any. */
const currentProjectIdFromPathname = (pathname: string): string | undefined =>
  /^\/projects\/([^/?#]+)/.exec(pathname)?.[1]

export const ProjectsSidebarNav = ({
  isOwner,
  onToggleStar,
  pathname,
  starredCollapsed,
  starredProjectIds,
  toggleStarredCollapsed,
}: ProjectsSidebarNavProps) => {
  const navigate = useNavigate()
  const { search } = useLocation()
  const activeBoardParam = new URLSearchParams(search).get('board')
  const nativeTouchShell = isReactNativeWebView()
  const phoneLayout = usePhoneLayout()
  const { data: projects = [] } = useProjects()
  const { data: attention } = useAttentionSummary()
  const deleteProject = useDeleteProject()
  const { pushToast } = useToasts()

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ProjectRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null)
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    PROJECT_NAV_SECTION_IDS,
    projectNavCookieName,
  )
  const [expandedProjectIds, setExpandedProjectIds] = useState(() =>
    parseExpandedProjectIds(getCookie(EXPANDED_PROJECT_IDS_COOKIE)),
  )
  const [collapsedBoardProjectIds, setCollapsedBoardProjectIds] = useState(() =>
    parseExpandedProjectIds(getCookie(COLLAPSED_BOARD_PROJECT_IDS_COOKIE)),
  )
  const [boardCreateProjectId, setBoardCreateProjectId] = useState<string | null>(null)

  const currentProjectId = currentProjectIdFromPathname(pathname)
  const currentSectionId = projectSectionIdFromPathname(pathname)
  const starredProjects = projects.filter((project) => starredProjectIds.has(project.id))
  // Starring promotes a project out of the list rather than copying it: the
  // Channels sidebar lifts a starred channel or project the same way
  // (`useSidebarTree.ts`), and one project drawn twice reads as two projects.
  const unstarredProjects = projects.filter((project) => !starredProjectIds.has(project.id))

  // Already cached: the row that offers "New board" is inside an expanded
  // project, and expanding one is what reads its boards.
  const { data: boardCreateBoards = [] } = useProjectBoards(boardCreateProjectId ?? undefined)

  const persistExpandedProjectIds = useCallback((projectIds: ReadonlySet<string>) => {
    setCookie(EXPANDED_PROJECT_IDS_COOKIE, serializeExpandedProjectIds(projectIds))
  }, [])

  const persistCollapsedBoardProjectIds = useCallback((projectIds: ReadonlySet<string>) => {
    setCookie(COLLAPSED_BOARD_PROJECT_IDS_COOKIE, serializeExpandedProjectIds(projectIds))
  }, [])

  const expandBoards = useCallback((projectId: string) => {
    setCollapsedBoardProjectIds((current) => {
      if (!current.has(projectId)) return current
      const next = new Set(current)
      next.delete(projectId)
      persistCollapsedBoardProjectIds(next)
      return next
    })
  }, [persistCollapsedBoardProjectIds])

  const toggleBoardsExpanded = useCallback((projectId: string) => {
    setCollapsedBoardProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      persistCollapsedBoardProjectIds(next)
      return next
    })
  }, [persistCollapsedBoardProjectIds])

  // Drop remembered expansions for projects that no longer exist, so the cookie
  // cannot grow without bound as projects come and go.
  useEffect(() => {
    if (projects.length === 0) return

    setExpandedProjectIds((current) => {
      const next = retainExpandedProjectIds(current, projects)
      if (next.size === current.size) return current
      persistExpandedProjectIds(next)
      return next
    })
    setCollapsedBoardProjectIds((current) => {
      const next = retainExpandedProjectIds(current, projects)
      if (next.size === current.size) return current
      persistCollapsedBoardProjectIds(next)
      return next
    })
  }, [persistCollapsedBoardProjectIds, persistExpandedProjectIds, projects])

  // Landing inside a project opens its sections, so a deep link never hides the
  // row the reader is standing on. It runs on entering a project and not again,
  // so collapsing the sections while you stay there sticks.
  useEffect(() => {
    if (!currentProjectId) return

    setExpandedProjectIds((current) => {
      if (current.has(currentProjectId)) return current
      const next = new Set(current).add(currentProjectId)
      persistExpandedProjectIds(next)
      return next
    })
  }, [currentProjectId, persistExpandedProjectIds])

  const toggleProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      persistExpandedProjectIds(next)
      return next
    })
  }, [persistExpandedProjectIds])

  // Opening the confirm is the whole of the menu action. The mutation lives in
  // `runDelete`, which nothing but the dialog's confirm control can reach.
  const handleDelete = (project: ProjectRecord) => {
    setDeleteTarget(project)
  }

  const runDelete = (project: ProjectRecord) => {
    setDeleteTarget(null)
    deleteProject.mutate(project.id, {
      onError: (error) =>
        pushToast({
          body: error instanceof Error ? error.message : 'Failed to delete project',
          title: 'Could not delete project',
        }),
    })
  }

  const handleBoardCreated = (board: BoardRecord) => {
    if (!boardCreateProjectId) return
    // A board nobody can see is not a board that was created: open the
    // list if it was closed, and land on what was just made. The very
    // first board of a project is its default, and a default board is
    // spelled without the param — the same link its row carries.
    expandBoards(boardCreateProjectId)
    const boardPath = `/projects/${boardCreateProjectId}/board`
    void navigate(
      board.isDefault
        ? boardPath
        : `${boardPath}?board=${encodeURIComponent(board.id)}`,
      { replace: currentProjectId === boardCreateProjectId },
    )
  }

  const renderProjectRow = (project: ProjectRecord, listId: ProjectListId) => {
    const isExpanded = expandedProjectIds.has(project.id)
    const projectPath = phoneLayout ? `/projects/${project.id}/board` : `/projects/${project.id}`

    return (
      <ProjectRow
        activeBoardParam={activeBoardParam}
        assignedWorkCount={attention?.assignedWork.projects[project.id] ?? 0}
        boardsExpanded={!collapsedBoardProjectIds.has(project.id)}
        currentProjectId={currentProjectId}
        currentSectionId={currentSectionId}
        isExpanded={isExpanded}
        isOwner={isOwner}
        isStarred={starredProjectIds.has(project.id)}
        key={`${listId}:${project.id}`}
        knowledgeCount={attention?.knowledge.projects[project.id] ?? 0}
        listId={listId}
        onCreateBoard={setBoardCreateProjectId}
        onDelete={handleDelete}
        onEdit={setEditTarget}
        onToggleBoardsExpanded={toggleBoardsExpanded}
        onToggleExpanded={toggleProjectExpanded}
        onToggleStar={onToggleStar}
        project={project}
        projectPath={projectPath}
      />
    )
  }

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <nav className="min-h-0 flex-1 overflow-y-auto py-1">
        {starredProjects.length > 0 ? (
          <SidebarMenuSection
            id="projects-nav-starred"
            isCollapsed={starredCollapsed}
            onToggle={toggleStarredCollapsed}
            title="Starred"
            titleIcon={
              <svg
                className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--warning-text)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            }
          >
            {starredProjects.map((project) => renderProjectRow(project, 'starred'))}
          </SidebarMenuSection>
        ) : null}

        <SidebarMenuSection
          action={
            isOwner ? (
              <button
                aria-label="New project"
                className="admin-sidebar-plus"
                onClick={() => setCreateOpen(true)}
                type="button"
              >
                +
              </button>
            ) : null
          }
          id="projects-nav-projects"
          isCollapsed={collapsedSections.projects ?? false}
          onToggle={() => toggleSection('projects')}
          title="Projects"
        >
          {projects.length === 0 ? (
            <SidebarEmptyNote>There are no projects in this team yet.</SidebarEmptyNote>
          ) : (
            // Empty when every project is starred — they are all in Starred
            // above, so there is nothing left to say here.
            unstarredProjects.map((project) => renderProjectRow(project, 'projects'))
          )}
        </SidebarMenuSection>
      </nav>

      <ProjectsNavDialogs
        boardCreateBoards={boardCreateBoards}
        boardCreateProjectId={boardCreateProjectId}
        createOpen={createOpen}
        deleteTarget={deleteTarget}
        editTarget={editTarget}
        onBoardCreated={handleBoardCreated}
        onCancelDelete={() => setDeleteTarget(null)}
        onCloseBoardCreate={() => setBoardCreateProjectId(null)}
        onCloseCreate={() => setCreateOpen(false)}
        onCloseEdit={() => setEditTarget(null)}
        onConfirmDelete={runDelete}
      />
    </aside>
  )
}
