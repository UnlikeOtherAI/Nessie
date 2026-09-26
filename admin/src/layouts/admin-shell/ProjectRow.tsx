import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { ProjectAvatar } from '../../components/primitives/ProjectAvatar'
import type { ProjectRecord } from '../../lib/api-client'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'
import { projectSettingsPath } from '../../navigation/project-sections'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { ProjectSectionRows, type ProjectListId } from './ProjectSectionRows'
import { sidebarAriaCurrent } from '../../components/shared/row-a11y'
import { useSidebarRowMenu } from './useSidebarRowMenu'
import { SidebarTreeChevron } from '../../components/primitives/SidebarTree'
import type { StarredItem } from './types'

type ProjectRowProps = {
  /** The raw `?board=` value, passed straight through to `ProjectSectionRows`. */
  activeBoardParam: string | null
  assignedWorkCount: number
  boardsExpanded: boolean
  currentProjectId?: string
  currentSectionId: string
  isExpanded: boolean
  isStarred: boolean
  knowledgeCount: number
  listId: ProjectListId
  onCreateBoard: (projectId: string) => void
  onToggleBoardsExpanded: (projectId: string) => void
  onToggleExpanded: (projectId: string) => void
  onToggleStar: (type: StarredItem['type'], id: string) => void
  /** Resolved by the caller from `usePhoneLayout()`: board on phone, overview elsewhere. */
  projectPath: string
  project: ProjectRecord
  showBoardSelection: boolean
}

/**
 * One project's tile in the Projects sidebar: avatar, name, the sections
 * disclosure, the star, and the "⋯" menu, whose one row opens the project's
 * Settings — where its name, picture, visibility and Delete now live, rather
 * than an edit dialog and a destructive row one slip from opening the project.
 * The menu's open/closed state lives here, one row at a time, rather than
 * lifted to the list that renders every row.
 */
export const ProjectRow = ({
  activeBoardParam,
  assignedWorkCount,
  boardsExpanded,
  currentProjectId,
  currentSectionId,
  isExpanded,
  isStarred,
  knowledgeCount,
  listId,
  onCreateBoard,
  onToggleBoardsExpanded,
  onToggleExpanded,
  onToggleStar,
  projectPath,
  project,
  showBoardSelection,
}: ProjectRowProps) => {
  const { token } = useAuthSession()
  const navigate = useNavigate()
  const prewarm = usePrewarm()
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)

  const closeMenu = useCallback(() => setIsMenuOpen(false), [])
  const { openAt, position: menuPosition } = useSidebarRowMenu(isMenuOpen, closeMenu)

  const rowId = `${listId}:${project.id}`
  const isActive = currentProjectId === project.id
  const sectionsId = `projects-nav-${listId}-${project.id}-sections`

  const toggleMenu = () => {
    if (isMenuOpen) {
      closeMenu()
      return
    }
    const rect = menuButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    openAt(rect)
    setIsMenuOpen(true)
  }

  // Settings is a section of the project: from inside the project it is a
  // tab switch and replaces, from anywhere else it is a real push.
  const openSettings = () => {
    closeMenu()
    void navigate(projectSettingsPath(project.id), { replace: isActive })
  }

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
            onToggleExpanded(project.id)
          }}
          type="button"
        >
          <SidebarTreeChevron expanded={isExpanded} className="h-3 w-3" />
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
        <span className="relative ml-1 flex-shrink-0">
            <button
              aria-label={`Project actions for ${project.name}`}
              aria-expanded={isMenuOpen}
              aria-haspopup="menu"
              className="admin-sidebar-more"
              onClick={(event) => {
                event.stopPropagation()
                toggleMenu()
              }}
              ref={menuButtonRef}
              type="button"
            >
              ⋯
            </button>
            {isMenuOpen && menuPosition
              ? createPortal(
                  <>
                    <button
                      aria-hidden="true"
                      className="fixed inset-0 z-[var(--layer-popover)] cursor-default"
                      onClick={closeMenu}
                      tabIndex={-1}
                      type="button"
                    />
                    <div
                      className="admin-sidebar-menu admin-sidebar-menu-project fixed z-[var(--layer-popover)]"
                      role="menu"
                      style={menuPosition}
                    >
                      <button onClick={openSettings} role="menuitem" type="button">
                        Project settings
                      </button>
                    </div>
                  </>,
                  document.body,
                )
              : null}
        </span>
      </div>

      {isExpanded ? (
        <div id={sectionsId}>
          <ProjectSectionRows
            activeBoardParam={activeBoardParam}
            assignedWorkCount={assignedWorkCount}
            boardsExpanded={boardsExpanded}
            currentProjectId={currentProjectId}
            currentSectionId={currentSectionId}
            knowledgeCount={knowledgeCount}
            listId={listId}
            onCreateBoard={onCreateBoard}
            onToggleBoardsExpanded={onToggleBoardsExpanded}
            projectId={project.id}
            showBoardSelection={showBoardSelection}
          />
        </div>
      ) : null}
    </div>
  )
}
