import { Fragment } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Link } from 'react-router-dom'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { useProjectBoards } from '../../facades/boards/hooks'
import { prewarmRowHandlers, usePrewarm } from '../../navigation/prewarm'
import { BOARD_ICON, projectSections } from '../../navigation/project-sections'
import { sidebarAriaCurrent } from '../../components/shared/row-a11y'
import { SidebarEmptyNote } from './SidebarEmptyNote'

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
export type ProjectListId = 'starred' | 'projects'

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
export const ProjectSectionRows = ({
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
                        {rowIcon(BOARD_ICON)}
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
