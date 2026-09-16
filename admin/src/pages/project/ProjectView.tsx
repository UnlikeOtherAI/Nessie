import { useEffect, useState } from 'react'
import {
  faBoxArchive,
  faList,
  faTableCellsLarge,
  faUsers,
} from '@fortawesome/free-solid-svg-icons'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiClientError } from '@nessie/client-core'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { TaskDialog } from '../../components/features/projects/kanban/TaskDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { type BoardTaskRecord, useProjectBoards } from '../../facades/boards/hooks'
import { BoardSwitcher } from '../../components/features/projects/kanban/BoardSwitcher'
import { BoardAssigneeFilter } from '../../components/features/projects/kanban/BoardAssigneeFilter'
import { useBoardChrome } from './useBoardChrome'
import { usePhoneLayout } from '../../navigation/mobile-shell'
import { useTabParam } from '../../navigation/useTabParam'
import { useRedirect } from '../../navigation/redirect'
import { projectSectionIdFromPathname } from '../../navigation/project-sections'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useCanModifyProject } from '../../facades/projects/administration'
import { usePresentedTask } from '../../facades/tasks/hooks'
import { Notice } from '../../components/primitives/Notice'
import { QueryState } from '../../components/shared/QueryState'
import { ProjectBacklogTab } from './ProjectBacklogTab'
import { ProjectBoardTab } from './ProjectBoardTab'
import { ProjectDocsTab } from './ProjectDocsTab'
import { ProjectInsightsTab } from './ProjectInsightsTab'
import { ProjectDashboardsTab } from './ProjectDashboardsTab'
import { ProjectExecutorsTab } from './ProjectExecutorsTab'
import { ProjectSettingsPage } from './ProjectSettingsPage'

export const ProjectView = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const redirect = useRedirect()
  const { data: projects = [] } = useProjects()
  const canAdminister = useCanModifyProject(projectId ?? null)
  const boardsQuery = useProjectBoards(projectId)
  // A previous project's boards are useful only while that project remains on
  // screen. Once the route changes, hold the destination in its loading state
  // rather than rendering the prior project's authorized board under this URL.
  const hasCurrentBoards = !boardsQuery.isPlaceholderData
  const boards = hasCurrentBoards ? boardsQuery.data ?? [] : []
  // No pinned sidebar on the single column, so the board strip stays there —
  // see `BoardSwitcher`. Read above the `projectId` guard: it is a hook.
  const singleColumn = usePhoneLayout()

  // Which board is on screen. A tab, so it rides in `?board=` written with
  // `replace`; an unknown or absent value reads as the project's default
  // board, so a stale bookmark degrades to the board the project opens on.
  // The boards themselves are chosen in the Projects sidebar, under this
  // project's Board section — the header carries no strip, because the sidebar
  // already draws every board and two doorways to the same choice only made
  // the reader guess which one moved them. The single-column layout is the
  // exception: it has no pinned sidebar, and the board screen's leading
  // doorway is Back, so there the strip is the only doorway there is.
  const defaultBoardId = boards.find((item) => item.isDefault)?.id ?? boards[0]?.id ?? ''
  const boardIds: string[] = boards.map((item) => item.id)
  const [activeBoardId, selectBoard] = useTabParam('board', boardIds, defaultBoardId)
  const board = boards.find((item) => item.id === activeBoardId) ?? null
  // A ticket detail is persistent route state: unlike a one-shot focus or
  // connect request, it remains addressable until the reader closes it.
  const requestedTaskId = new URLSearchParams(location.search).get('task')
  const taskQuery = usePresentedTask(requestedTaskId ?? undefined)
  // Only a successful response for this exact URL may drive navigation. The
  // cache can retain data while a refetch is rejected, but access never does.
  const requestedTask = !taskQuery.isError && requestedTaskId === taskQuery.data?.id
    ? taskQuery.data
    : null
  const taskIsInProject = requestedTask?.projectId === projectId
  // Board placement is an entitled server projection. In particular, an
  // explicit board that has gone away is unresolved rather than a reason to
  // put the ticket in this project's default board.
  const taskPlacement = taskIsInProject ? requestedTask?.boardPlacement : null
  const taskBoard = taskPlacement
    ? boards.find((item) => item.id === taskPlacement.boardId) ?? null
    : null
  const taskColumnId = requestedTask?.boardPlacement?.columnId
  const taskReadDenied = taskQuery.error instanceof ApiClientError
    && (taskQuery.error.status === 403 || taskQuery.error.status === 404)
  const taskUnavailable = Boolean(
    requestedTaskId
    && (taskReadDenied || (requestedTask !== null && !taskIsInProject && !requestedTask.projectId)),
  )
  const taskReadFailed = Boolean(requestedTaskId && taskQuery.isError && !taskReadDenied)
  const taskBoardUnavailable = Boolean(
    requestedTaskId
    && taskIsInProject
    && requestedTask
    && (!requestedTask.boardPlacement || (!taskBoard && hasCurrentBoards && !boardsQuery.isLoading)),
  )

  const project = projects.find((p) => p.id === projectId)
  // Backlog and Insights are project-level, so they appear when *any* board of
  // this project runs sprints — not only when the one on screen does.
  const isScrum = boards.some((item) => item.style === 'scrum')
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  // Read here as well as in `ProjectBoardTab` — one URL and one query cache
  // behind both, so the header's controls and the board they steer cannot
  // disagree. Above the `projectId` guard with every other hook.
  const chrome = useBoardChrome(projectId, board?.id)

  // A card message says only which ticket it refers to. Its live record is the
  // authority for the board, so an old message cannot return somebody to the
  // board the ticket used to occupy.
  useEffect(() => {
    if (!requestedTask) return
    if (requestedTask.projectId && requestedTask.projectId !== projectId) {
      redirect(
        `/projects/${requestedTask.projectId}/board?task=${encodeURIComponent(requestedTask.id)}`,
        { state: location.state },
      )
      return
    }
    if (!taskIsInProject || !taskBoard || activeBoardId === taskBoard.id) return
    selectBoard(taskBoard.id)
  }, [activeBoardId, location.state, projectId, redirect, requestedTask, selectBoard, taskBoard, taskIsInProject])

  // `projectId` only goes missing on a malformed URL, and the guard sits below
  // every hook so the hook order never depends on it (rules-of-hooks). The
  // queries above already no-op on an undefined id.
  if (!projectId) return null
  // A project's sections are chosen in the Projects sidebar, which draws them
  // as the project's subpages (`navigation/project-sections.ts`). The header
  // carries no section dropdown: two doorways to the same seven routes only
  // made the reader guess which one moved them.
  const tab = projectSectionIdFromPathname(location.pathname)
  // A board is on screen: the only section whose header is the board's own.
  const onBoard = tab === 'board'

  const openTask = (task: BoardTaskRecord) => {
    const params = new URLSearchParams(location.search)
    params.set('task', task.id)
    void navigate(
      { pathname: location.pathname, search: `?${params.toString()}` },
      { state: location.state },
    )
  }

  const closeTaskDetail = () => {
    const params = new URLSearchParams(location.search)
    params.delete('task')
    void navigate(
      { pathname: location.pathname, search: params.size > 0 ? `?${params.toString()}` : '' },
      { replace: true, state: location.state },
    )
  }

  const retryTaskDetail = () => {
    void boardsQuery.refetch()
    void taskQuery.refetch()
  }
  const boardsFailedWithContent = Boolean(boardsQuery.isError && hasCurrentBoards && boardsQuery.data)

  // The board's whole chrome is one row: the assignee filter, everything the
  // board can be configured to show, and New task. What used to be a second
  // toolbar beneath the header — a view strip, the filter and a collapsible
  // Archived drawer — is either here or, for Archived, a column of the board
  // itself, so the only thing under the header's rule is the board.
  const boardActions = (openMembers: () => void): PageHeaderAction[] => [
    {
      id: 'board-assignee',
      kind: 'custom',
      // Whose cards are on screen is the state the board is read through, and
      // a menu row cannot stand in for a picker with avatars and a search.
      label: 'Filter board by assignee',
      pinned: true,
      priority: 90,
      render: () => (
        <BoardAssigneeFilter
          compact={singleColumn}
          currentUserId={chrome.currentUserId}
          onChange={chrome.setAssignee}
          people={chrome.people}
          remote={chrome.remote}
          value={chrome.assignee}
        />
      ),
    },
    {
      id: 'board-configure',
      items: [
        {
          checked: chrome.view === 'cards',
          icon: faTableCellsLarge,
          id: 'view-cards',
          label: 'Cards',
          onSelect: () => chrome.setView('cards'),
        },
        {
          checked: chrome.view === 'lines',
          icon: faList,
          id: 'view-lines',
          label: 'Lines',
          onSelect: () => chrome.setView('lines'),
          title: 'One line per card: title and priority only',
        },
        {
          checkbox: true,
          checked: chrome.showArchived,
          icon: faBoxArchive,
          id: 'show-archived',
          label: 'Show archived',
          onSelect: () => chrome.setShowArchived(!chrome.showArchived),
          title: 'Add a last column for cancelled and failed work',
        },
        ...(project
          ? [
              {
                icon: faUsers,
                id: 'project-members',
                label: `Members (${project.memberCount})`,
                onSelect: openMembers,
              },
            ]
          : []),
        // The doorways to board administration, from the screen a person is
        // standing on when they want them — not only from Settings.
        ...(canAdminister
          ? [
              {
                id: 'edit-columns',
                label: 'Board settings…',
                onSelect: () =>
                  void navigate(
                    board
                      ? `/projects/${projectId}/boards/${board.id}/settings`
                      : `/projects/${projectId}/boards`,
                  ),
              },
              {
                id: 'new-board',
                label: 'New board…',
                onSelect: () => void navigate(`/projects/${projectId}/boards?create=board`),
              },
            ]
          : []),
      ],
      kind: 'menu',
      // Not "Board": the title already names this board, so a second "Board"
      // here would name no decision.
      label: 'Configure',
      priority: 60,
      title: 'Configure this board',
    },
    {
      id: 'new-task',
      label: 'New task',
      onSelect: () => setTaskDialogOpen(true),
      primary: true,
      priority: 100,
    },
  ]

  return (
    // Overview is navigational, so the whole screen — header included — takes
    // the menus' colour; every other section is a work surface and keeps the
    // white one. See `.admin-nav-surface` in `styles.css`.
    <section
      className={[
        tab === 'overview' ? 'admin-nav-surface' : '',
        'flex h-full min-h-0 flex-col',
      ].join(' ')}
    >
      <ProjectPageHeader
        actions={onBoard ? boardActions : []}
        membersAction={!onBoard}
        project={project}
        tabs={
          onBoard && singleColumn ? (
            <BoardSwitcher
              activeBoardId={activeBoardId}
              boards={boards}
              onSelect={selectBoard}
            />
          ) : undefined
        }
        // The board names itself. The project is one row up in the sidebar and
        // one press back on a phone, and repeating it here cost the row that
        // used to carry the board's own name as a subtitle.
        title={onBoard ? board?.name : undefined}
      />

      <div className="min-h-0 flex-1">
        {tab === 'settings' ? (
          <ProjectSettingsPage projectId={projectId} />
        ) : tab === 'docs' ? (
          <ProjectDocsTab projectId={projectId} />
        ) : tab === 'backlog' ? (
          <ProjectBacklogTab projectId={projectId} />
        ) : tab === 'insights' ? (
          <ProjectInsightsTab projectId={projectId} />
        ) : tab === 'dashboards' ? (
          <ProjectDashboardsTab projectId={projectId} />
        ) : tab === 'executors' ? (
          <ProjectExecutorsTab projectId={projectId} />
        ) : tab === 'overview' ? (
          <ProjectDashboard projectId={projectId} />
        ) : (
          <QueryState
            emptyLabel="This project has no boards yet."
            errorLabel="Failed to load boards."
            isEmpty={boards.length === 0}
            loadingLabel="Loading boards…"
            query={{
              isError: boardsQuery.isError && !boardsFailedWithContent,
              isLoading: boardsQuery.isLoading || !hasCurrentBoards,
              refetch: boardsQuery.refetch,
            }}
          >
            {() => (
              <>
                {boardsFailedWithContent ? (
                  <Notice className="m-4" role="alert" size="sm" tone="danger">
                    Couldn&apos;t refresh boards.
                    <button className="ml-2 underline" onClick={() => void boardsQuery.refetch()} type="button">
                      Retry
                    </button>
                  </Notice>
                ) : null}
                <ProjectBoardTab board={board} onOpenTask={openTask} projectId={projectId} />
              </>
            )}
          </QueryState>
        )}
      </div>
      {taskUnavailable ? (
        <Notice className="m-4" role="alert" size="sm" tone="danger">
          That ticket is no longer available to you.
          <button className="ml-2 underline" onClick={closeTaskDetail} type="button">
            Close ticket
          </button>
        </Notice>
      ) : null}
      {taskReadFailed ? (
        <Notice className="m-4" role="alert" size="sm" tone="danger">
          The ticket could not be loaded.
          <button className="ml-2 underline" onClick={retryTaskDetail} type="button">
            Retry
          </button>
        </Notice>
      ) : null}
      {taskBoardUnavailable ? (
        <Notice className="m-4" role="alert" size="sm" tone="danger">
          That ticket&apos;s board is not available yet.
          <button className="ml-2 underline" onClick={retryTaskDetail} type="button">
            Retry
          </button>
          <button className="ml-2 underline" onClick={closeTaskDetail} type="button">
            Close ticket
          </button>
        </Notice>
      ) : null}
      <TaskDialog
        boardId={taskIsInProject ? taskBoard?.id : board?.id}
        iterationId={(taskIsInProject ? taskBoard : board)?.style === 'scrum' ? activeIteration?.id : undefined}
        onClose={taskIsInProject ? closeTaskDetail : () => setTaskDialogOpen(false)}
        open={taskDialogOpen || Boolean(taskIsInProject && taskBoard)}
        projectId={projectId}
        task={taskIsInProject ? requestedTask : null}
        taskColumnId={taskIsInProject ? taskColumnId : undefined}
      />
    </section>
  )
}
