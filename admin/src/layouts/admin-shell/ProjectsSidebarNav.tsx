import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { BoardIcon } from '../../components/kanban/BoardIcon'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BoardCreateDialog } from '../../components/kanban/BoardCreateDialog'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { EditProjectDialog } from '../../components/shared/EditProjectDialog'
import { ProjectAvatar } from '../../components/primitives/ProjectAvatar'
import { useAttentionSummary } from '../../facades/alerts/hooks'
import { useProjectBoards } from '../../facades/boards/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { useDeleteProject, useProjects } from '../../facades/projects/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { getCookie, setCookie } from '../../lib/storage'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'
import {
  BOARD_ICON,
  projectSectionIdFromPathname,
  projectSections,
} from '../../navigation/project-sections'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SidebarEmptyNote } from './SidebarEmptyNote'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'
import { sidebarAriaCurrent } from './SidebarRow'
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

type ProjectMenuPosition = {
  left: number
  top: number
}

/**
 * A subordinate row's glyph, at the size and dimness the channel `#` already
 * uses. `.admin-sb-item.active svg` lifts it to the readable foreground when
 * the row is selected, so nothing here has to know about selection.
 */
const rowIcon = (icon: typeof BOARD_ICON) => (
  <FontAwesomeIcon
    className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
    fixedWidth
    icon={icon}
  />
)

/** Which list a row belongs to, so Starred and Projects can show one project twice. */
type ProjectListId = 'starred' | 'projects'

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

export const parseExpandedProjectIds = (value: string | null): Set<string> => {
  if (!value) return new Set()

  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

export const retainExpandedProjectIds = (
  expandedProjectIds: ReadonlySet<string>,
  projects: readonly ProjectRecord[],
): Set<string> => {
  const projectIds = new Set(projects.map((project) => project.id))
  return new Set([...expandedProjectIds].filter((projectId) => projectIds.has(projectId)))
}

export const serializeExpandedProjectIds = (expandedProjectIds: ReadonlySet<string>): string =>
  JSON.stringify([...expandedProjectIds])

/** The project a projects-section pathname is standing in, if any. */
const currentProjectIdFromPathname = (pathname: string): string | undefined =>
  /^\/projects\/([^/?#]+)/.exec(pathname)?.[1]

type ProjectSectionRowsProps = {
  /** The raw `?board=` value, resolved against this project's boards below. */
  activeBoardParam: string | null
  assignedWorkCount: number
  boardsExpanded: boolean
  currentProjectId?: string
  currentSectionId: string
  knowledgeCount: number
  listId: ProjectListId
  onCreateBoard: (projectId: string) => void
  onToggleBoardsExpanded: (projectId: string) => void
  projectId: string
}

/**
 * A project's sections as sidebar children. The boards read only happens for an
 * expanded project — that one query is what says whether the project runs
 * sprints, and so whether Backlog and Insights belong in the list.
 */
const ProjectSectionRows = ({
  activeBoardParam,
  assignedWorkCount,
  boardsExpanded,
  currentProjectId,
  currentSectionId,
  knowledgeCount,
  listId,
  onCreateBoard,
  onToggleBoardsExpanded,
  projectId,
}: ProjectSectionRowsProps) => {
  const prewarm = usePrewarm()
  const { data: boards = [] } = useProjectBoards(projectId)
  const canAdministerProject = useCanAdministerProject(projectId)
  const isScrum = boards.some((board) => board.style === 'scrum')
  const isCurrentProject = currentProjectId === projectId
  const boardsId = `projects-nav-${listId}-${projectId}-boards`
  // The board screen resolves an unknown or absent `?board=` to the project's
  // default board (`useTabParam`), so the row highlighted here has to agree.
  const defaultBoardId = boards.find((board) => board.isDefault)?.id ?? boards[0]?.id ?? null
  const activeBoardId = boards.some((board) => board.id === activeBoardParam)
    ? activeBoardParam
    : defaultBoardId

  return (
    <>
      {projectSections({ assignedWorkCount, isScrum, knowledgeCount, projectId }).map(
        (section) => {
          const isActive = isCurrentProject && section.id === currentSectionId
          // A project section is a tab, and a tab is never a history entry
          // (docs/navigation/overview.md §1, "Tab hosts"): switching sections
          // inside the project already on screen replaces the entry, so Back
          // leaves the project rather than walking its sections. Arriving from
          // outside the project is a real push.
          const rowProps = {
            replace: isCurrentProject,
            to: section.to,
            ...prewarmRowHandlers(prewarm, section.to),
          }

          if (section.id !== 'board') {
            return (
              <Link
                aria-current={sidebarAriaCurrent(isActive)}
                className={['admin-sb-item sidebar-child group', isActive ? 'active' : ''].join(' ')}
                key={`${listId}-${projectId}-${section.id}`}
                {...rowProps}
              >
                {rowIcon(section.icon)}
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
              </Link>
            )
          }

          // Board is the one section that holds a list. Its boards are tabs of
          // the one board screen, so they are rows under it rather than routes
          // of their own — and while one of them is selected, Board itself
          // stays visible as the softer parent.
          return (
            <Fragment key={`${listId}-${projectId}-${section.id}`}>
              <div
                className={[
                  'admin-sb-item sidebar-child group',
                  isActive ? (boardsExpanded && boards.length > 0 ? 'active-parent' : 'active') : '',
                ].join(' ')}
              >
                <Link
                  aria-current={sidebarAriaCurrent(isActive && !boardsExpanded)}
                  className="sidebar-project-link"
                  {...rowProps}
                >
                  {rowIcon(section.icon)}
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                </Link>
                <button
                  aria-controls={boardsId}
                  aria-expanded={boardsExpanded}
                  aria-label={`${boardsExpanded ? 'Collapse' : 'Expand'} boards`}
                  className="admin-sidebar-more flex-shrink-0"
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleBoardsExpanded(projectId)
                  }}
                  type="button"
                >
                  <svg
                    className={[
                      'h-3 w-3 transition-transform',
                      boardsExpanded ? '' : '-rotate-90',
                    ].join(' ')}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    viewBox="0 0 24 24"
                  >
                    <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {canAdministerProject ? (
                  <button
                    aria-label="New board"
                    className="admin-sidebar-more flex-shrink-0"
                    onClick={(event) => {
                      event.stopPropagation()
                      onCreateBoard(projectId)
                    }}
                    type="button"
                  >
                    +
                  </button>
                ) : null}
              </div>

              {boardsExpanded ? (
                <div id={boardsId}>
                  {boards.length === 0 ? (
                    // The same quiet line every other empty sidebar section
                    // shows, on the grid its board rows would stand on. The
                    // "+" on the Boards row beside it is the way in.
                    <SidebarEmptyNote indent="grandchild">There are no boards yet.</SidebarEmptyNote>
                  ) : null}
                  {boards.map((board) => {
                    const isActiveBoard = isActive && board.id === activeBoardId
                    // `?board=` is how the board screen reads its selection
                    // (`useTabParam`), and it drops the param for the default
                    // board so the common URL stays clean.
                    const to = board.isDefault
                      ? section.to
                      : `${section.to}?board=${encodeURIComponent(board.id)}`
                    return (
                      <Link
                        aria-current={sidebarAriaCurrent(isActiveBoard)}
                        className={[
                          'admin-sb-item sidebar-grandchild group',
                          isActiveBoard ? 'active' : '',
                        ].join(' ')}
                        key={`${listId}-${projectId}-board-${board.id}`}
                        replace={isCurrentProject}
                        to={to}
                        {...prewarmRowHandlers(prewarm, section.to)}
                      >
                        <BoardIcon
                          className="text-[color:var(--tx3)]"
                          iconEmoji={board.iconEmoji}
                        />
                        <span className="min-w-0 flex-1 truncate">{board.name}</span>
                      </Link>
                    )
                  })}
                </div>
              ) : null}
            </Fragment>
          )
        },
      )}
    </>
  )
}

export const ProjectsSidebarNav = ({
  isOwner,
  onToggleStar,
  pathname,
  starredCollapsed,
  starredProjectIds,
  toggleStarredCollapsed,
}: ProjectsSidebarNavProps) => {
  const { token } = useAuthSession()
  const navigate = useNavigate()
  const { search } = useLocation()
  const activeBoardParam = new URLSearchParams(search).get('board')
  const nativeTouchShell = isReactNativeWebView()
  const phoneLayout = usePhoneLayout()
  const prewarm = usePrewarm()
  const { data: projects = [] } = useProjects()
  const { data: attention } = useAttentionSummary()
  const deleteProject = useDeleteProject()

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ProjectRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectRecord | null>(null)
  const [menuRowId, setMenuRowId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<ProjectMenuPosition | null>(null)
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>())
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

  const closeMenu = useCallback(() => {
    setMenuRowId(null)
    setMenuPosition(null)
  }, [])

  const openMenu = useCallback((rowId: string) => {
    const rect = menuButtonRefs.current.get(rowId)?.getBoundingClientRect()
    if (!rect) return
    setMenuRowId(rowId)
    setMenuPosition({ left: rect.left, top: rect.bottom + 4 })
  }, [])

  useLayoutEffect(() => {
    if (!menuPosition) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('resize', closeMenu)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('resize', closeMenu)
    }
  }, [closeMenu, menuPosition])

  // Opening the confirm is the whole of the menu action. The mutation lives in
  // `runDelete`, which nothing but the dialog's confirm control can reach.
  const handleDelete = (project: ProjectRecord) => {
    closeMenu()
    setDeleteTarget(project)
  }

  const runDelete = (project: ProjectRecord) => {
    setDeleteTarget(null)
    deleteProject.mutate(project.id, {
      onError: (error) =>
        window.alert(error instanceof Error ? error.message : 'Failed to delete project'),
    })
  }

  const renderProjectRow = (project: ProjectRecord, listId: ProjectListId) => {
    const rowId = `${listId}:${project.id}`
    const isStarred = starredProjectIds.has(project.id)
    const isExpanded = expandedProjectIds.has(project.id)
    const isMenuOpen = menuRowId === rowId
    const isActive = currentProjectId === project.id
    const sectionsId = `projects-nav-${listId}-${project.id}-sections`
    // On a phone the project row is the push into the project, and its first
    // screen is the board; on desktop the row lands on the project's Overview.
    const projectPath = phoneLayout ? `/projects/${project.id}/board` : `/projects/${project.id}`
    const assignedWorkCount = attention?.assignedWork.projects[project.id] ?? 0
    const knowledgeCount = attention?.knowledge.projects[project.id] ?? 0

    return (
      <div className="mt-1" key={rowId}>
        <div
          className={[
            'admin-sb-item sidebar-project-tile group',
            isActive ? (isExpanded && currentSectionId !== 'overview' ? 'active-parent' : 'active') : '',
          ].join(' ')}
        >
          <Link
            aria-current={sidebarAriaCurrent(isActive && currentSectionId === 'overview')}
            className="sidebar-project-link"
            to={projectPath}
            {...prewarmRowHandlers(prewarm, projectPath)}
          >
            <ProjectAvatar
              avatarAttachmentId={project.avatarAttachmentId}
              avatarEmoji={project.avatarEmoji}
              size={18}
              token={token}
            />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
          </Link>
          <button
            aria-controls={sectionsId}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name} sections`}
            className="admin-sidebar-more flex-shrink-0"
            onClick={(event) => {
              event.stopPropagation()
              toggleProjectExpanded(project.id)
            }}
            type="button"
          >
            <svg
              className={['h-3 w-3 transition-transform', isExpanded ? '' : '-rotate-90'].join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span
            className={[
              'sidebar-row-star flex-shrink-0 cursor-pointer px-0.5 text-sm leading-none transition-opacity',
              isStarred
                ? 'ml-1 text-[color:var(--warning-text)] opacity-100'
                : 'ml-auto text-[color:var(--tx3)] opacity-0 group-hover:opacity-100',
            ].join(' ')}
            onClick={(event) => {
              event.stopPropagation()
              onToggleStar('project', project.id)
            }}
          >
            {isStarred ? '★' : '☆'}
          </span>
          {isOwner ? (
            <span className="relative ml-1 flex-shrink-0">
              <button
                aria-label={`Project actions for ${project.name}`}
                aria-expanded={isMenuOpen}
                aria-haspopup="menu"
                className="admin-sidebar-more"
                onClick={(event) => {
                  event.stopPropagation()
                  if (isMenuOpen) {
                    closeMenu()
                    return
                  }
                  openMenu(rowId)
                }}
                ref={(element) => {
                  if (element) {
                    menuButtonRefs.current.set(rowId, element)
                  } else {
                    menuButtonRefs.current.delete(rowId)
                  }
                }}
                type="button"
              >
                ⋯
              </button>
              {isMenuOpen && menuPosition
                ? createPortal(
                    <>
                      <button
                        aria-hidden="true"
                        className="fixed inset-0 z-[60] cursor-default"
                        onClick={closeMenu}
                        tabIndex={-1}
                        type="button"
                      />
                      <div
                        className="admin-sidebar-menu admin-sidebar-menu-project fixed z-[61]"
                        role="menu"
                        style={menuPosition}
                      >
                        <button
                          onClick={() => {
                            closeMenu()
                            setEditTarget(project)
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Edit
                        </button>
                        <button
                          className="admin-sidebar-menu-danger"
                          onClick={() => handleDelete(project)}
                          role="menuitem"
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </>,
                    document.body,
                  )
                : null}
            </span>
          ) : null}
        </div>

        {isExpanded ? (
          <div id={sectionsId}>
            <ProjectSectionRows
              activeBoardParam={activeBoardParam}
              assignedWorkCount={assignedWorkCount}
              boardsExpanded={!collapsedBoardProjectIds.has(project.id)}
              currentProjectId={currentProjectId}
              currentSectionId={currentSectionId}
              knowledgeCount={knowledgeCount}
              listId={listId}
              onCreateBoard={setBoardCreateProjectId}
              onToggleBoardsExpanded={toggleBoardsExpanded}
              projectId={project.id}
            />
          </div>
        ) : null}
      </div>
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

      <CreateProjectDialog onClose={() => setCreateOpen(false)} open={createOpen} />
      {boardCreateProjectId ? (
        <BoardCreateDialog
          boards={boardCreateBoards}
          onClose={() => setBoardCreateProjectId(null)}
          onCreated={(board) => {
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
          }}
          open
          projectId={boardCreateProjectId}
        />
      ) : null}
      {editTarget ? (
        <EditProjectDialog
          onClose={() => setEditTarget(null)}
          open
          project={editTarget}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          body="This cannot be undone."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => runDelete(deleteTarget)}
          open
          title={`Delete project "${deleteTarget.name}"?`}
        />
      ) : null}
    </aside>
  )
}
