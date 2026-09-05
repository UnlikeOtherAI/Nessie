import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { faChevronDown, faEllipsis, faPlus } from '@fortawesome/free-solid-svg-icons'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { CreateProjectDialog } from '../../components/shared/CreateProjectDialog'
import { EditProjectDialog } from '../../components/shared/EditProjectDialog'
import { ProjectAvatar } from '../../components/primitives/ProjectAvatar'
import { useAttentionSummary } from '../../facades/alerts/hooks'
import { useProjectBoards } from '../../facades/boards/hooks'
import { useDeleteProject, useProjects } from '../../facades/projects/hooks'
import type { ProjectRecord } from '../../lib/api-client'
import { getCookie, setCookie } from '../../lib/storage'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'
import {
  projectSectionIdFromPathname,
  projectSections,
} from '../../navigation/project-sections'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'
import { SidebarIconButton, SidebarStarIcon } from './SidebarIcons'
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

/** Which list a row belongs to, so Starred and Projects can show one project twice. */
type ProjectListId = 'starred' | 'projects'

const PROJECT_NAV_SECTION_IDS: ProjectNavSectionId[] = ['projects']

const projectNavCookieName = (id: ProjectNavSectionId) => `projectsNavCollapsed-${id}`

const EXPANDED_PROJECT_IDS_COOKIE = 'projectsNavExpandedIds'

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
  assignedWorkCount: number
  currentProjectId?: string
  currentSectionId: string
  knowledgeCount: number
  listId: ProjectListId
  projectId: string
}

/**
 * A project's sections as sidebar children. The boards read only happens for an
 * expanded project — that one query is what says whether the project runs
 * sprints, and so whether Backlog and Insights belong in the list.
 */
const ProjectSectionRows = ({
  assignedWorkCount,
  currentProjectId,
  currentSectionId,
  knowledgeCount,
  listId,
  projectId,
}: ProjectSectionRowsProps) => {
  const prewarm = usePrewarm()
  const { data: boards = [] } = useProjectBoards(projectId)
  const isScrum = boards.some((board) => board.style === 'scrum')
  const isCurrentProject = currentProjectId === projectId

  return (
    <>
      {projectSections({ assignedWorkCount, isScrum, knowledgeCount, projectId }).map(
        (section) => {
          const isActive = isCurrentProject && section.id === currentSectionId
          return (
            <Link
              aria-current={sidebarAriaCurrent(isActive)}
              className={['admin-sb-item sidebar-child group', isActive ? 'active' : ''].join(' ')}
              key={`${listId}-${projectId}-${section.id}`}
              // A project section is a tab, and a tab is never a history entry
              // (docs/navigation/overview.md §1, "Tab hosts"): switching sections
              // inside the project already on screen replaces the entry, so Back
              // leaves the project rather than walking its sections. Arriving from
              // outside the project is a real push.
              replace={isCurrentProject}
              to={section.to}
              {...prewarmRowHandlers(prewarm, section.to)}
            >
              <span className="min-w-0 flex-1 truncate">{section.label}</span>
            </Link>
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

  const currentProjectId = currentProjectIdFromPathname(pathname)
  const currentSectionId = projectSectionIdFromPathname(pathname)
  const starredProjects = projects.filter((project) => starredProjectIds.has(project.id))

  const persistExpandedProjectIds = useCallback((projectIds: ReadonlySet<string>) => {
    setCookie(EXPANDED_PROJECT_IDS_COOKIE, serializeExpandedProjectIds(projectIds))
  }, [])

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
  }, [persistExpandedProjectIds, projects])

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
          <SidebarIconButton
            aria-controls={sectionsId}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name} sections`}
            className="flex-shrink-0"
            icon={faChevronDown}
            iconClassName={['h-3 w-3 transition-transform', isExpanded ? '' : '-rotate-90'].join(' ')}
            onClick={(event) => {
              event.stopPropagation()
              toggleProjectExpanded(project.id)
            }}
          />
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
            <SidebarStarIcon starred={isStarred} />
          </span>
          {isOwner ? (
            <span className="relative ml-1 flex-shrink-0">
              <SidebarIconButton
                aria-label={`Project actions for ${project.name}`}
                aria-expanded={isMenuOpen}
                aria-haspopup="menu"
                icon={faEllipsis}
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
              />
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
              assignedWorkCount={assignedWorkCount}
              currentProjectId={currentProjectId}
              currentSectionId={currentSectionId}
              knowledgeCount={knowledgeCount}
              listId={listId}
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
            titleIcon={<SidebarStarIcon starred />}
          >
            {starredProjects.map((project) => renderProjectRow(project, 'starred'))}
          </SidebarMenuSection>
        ) : null}

        <SidebarMenuSection
          action={
            isOwner ? (
              <SidebarIconButton
                aria-label="New project"
                icon={faPlus}
                onClick={() => setCreateOpen(true)}
                placement="section"
              />
            ) : null
          }
          id="projects-nav-projects"
          isCollapsed={collapsedSections.projects ?? false}
          onToggle={() => toggleSection('projects')}
          title="Projects"
        >
          {projects.length === 0 ? (
            isOwner ? (
              <button
                className={[
                  'mx-2 flex w-[calc(100%-1rem)] rounded-md border border-dashed',
                  'border-[color:var(--sep)] bg-[var(--overlay-weak)] px-3 py-3',
                  'text-left text-sm text-[color:var(--tx3)] hover:bg-[var(--overlay)]',
                ].join(' ')}
                onClick={() => setCreateOpen(true)}
                type="button"
              >
                Create your first project.
              </button>
            ) : (
              <div className="px-5 py-2 text-[13px] text-[color:var(--tx3)]">No projects yet.</div>
            )
          ) : (
            projects.map((project) => renderProjectRow(project, 'projects'))
          )}
        </SidebarMenuSection>
      </nav>

      <CreateProjectDialog onClose={() => setCreateOpen(false)} open={createOpen} />
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
