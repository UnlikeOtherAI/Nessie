import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiClientError } from '@nessie/client-core'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { TaskDialog } from '../../components/features/projects/kanban/TaskDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { type BoardTaskRecord, useProjectBoards } from '../../facades/boards/hooks'
import { BoardSwitcher } from '../../components/features/projects/kanban/BoardSwitcher'
import { usePhoneLayout } from '../../navigation/mobile-shell'
import { useTabParam } from '../../navigation/useTabParam'
import { useRedirect } from '../../navigation/redirect'
import { projectSectionIdFromPathname } from '../../navigation/project-sections'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { usePresentedTask } from '../../facades/tasks/hooks'
import { Notice } from '../../components/primitives/Notice'
import { ProjectBacklogTab } from './ProjectBacklogTab'
import { ProjectBoardTab } from './ProjectBoardTab'
import { ProjectDocsTab } from './ProjectDocsTab'
import { ProjectInsightsTab } from './ProjectInsightsTab'
import { ProjectExecutorsTab } from './ProjectExecutorsTab'
import { ProjectSettingsPage } from './ProjectSettingsPage'

export const ProjectView = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const redirect = useRedirect()
  const { data: projects = [] } = useProjects()
  const canAdminister = useCanAdministerProject(projectId ?? null)
  const boardsQuery = useProjectBoards(projectId)
  const boards = boardsQuery.data ?? []
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
    && (!requestedTask.boardPlacement || (!taskBoard && !boardsQuery.isLoading)),
  )

  const project = projects.find((p) => p.id === projectId)
  // Backlog and Insights are project-level, so they appear when *any* board of
  // this project runs sprints — not only when the one on screen does.
  const isScrum = boards.some((item) => item.style === 'scrum')
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)

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

  const headerActions: PageHeaderAction[] = [
    // The doorways to board administration, from the screen a person is
    // standing on when they want them — not only from Settings.
    ...(tab === 'board' && canAdminister
      ? [
          {
            id: 'board-admin',
            items: [
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
                onSelect: () =>
                  void navigate(
                    `/projects/${projectId}/boards?create=board`,
                  ),
              },
            ],
            kind: 'menu',
            // Not "Board": the sidebar already names this board on the row the
            // reader clicked, so a second "Board" here would name no decision.
            label: 'Configure',
            priority: 60,
            title: 'Configure boards',
          } satisfies PageHeaderAction,
          {
            id: 'new-task',
            label: 'New task',
            onSelect: () => setTaskDialogOpen(true),
            primary: true,
            priority: 100,
          } satisfies PageHeaderAction,
        ]
      : []),
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ProjectPageHeader
        actions={headerActions}
        project={project}
        subtitle={
          tab === 'board' && boards.length > 1 && !singleColumn ? board?.name : undefined
        }
        tabs={
          tab === 'board' && singleColumn ? (
            <BoardSwitcher
              activeBoardId={activeBoardId}
              boards={boards}
              onSelect={selectBoard}
            />
          ) : undefined
        }
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
        ) : tab === 'executors' ? (
          <ProjectExecutorsTab projectId={projectId} />
        ) : tab === 'overview' ? (
          <ProjectDashboard projectId={projectId} />
        ) : (
          <ProjectBoardTab board={board} onOpenTask={openTask} projectId={projectId} />
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
