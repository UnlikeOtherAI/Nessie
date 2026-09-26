import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { KanbanBoard } from '../../components/features/projects/kanban/KanbanBoard'
import { ALL_ASSIGNEES } from '../../components/features/projects/kanban/board-assignee-filter'
import type { BoardColumnView } from '../../components/features/projects/kanban/kanban-config'
import type { BoardRecord, BoardTaskRecord } from '../../facades/boards/hooks'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useMoveTask } from '../../facades/tasks/hooks'
import { useClearProjectAttention } from '../../facades/alerts/clear-project-attention'
import { EmptyState } from '../../components/shared/EmptyState'
import { QueryState } from '../../components/shared/QueryState'
import { Skeleton } from '../../components/primitives/Skeleton'
import { Notice } from '../../components/primitives/Notice'
import { BoardStartWorkDialog } from '../../components/features/ticket-work/BoardStartWorkDialog'
import { useBoardTicketWork } from '../../facades/ticket-work/hooks'
import { useBoardChrome } from './useBoardChrome'

type ProjectBoardTabProps = {
  board: BoardRecord | null
  onOpenTask: (task: BoardTaskRecord) => void
  projectId: string
}

export const ProjectBoardTab = ({ board, onOpenTask, projectId }: ProjectBoardTabProps) => {
  const { t } = useTranslation('projects')
  // The header owns the controls; this owns the board. Both read the same URL
  // and the same query cache through `useBoardChrome`, so there is one answer
  // to what is on screen rather than a prop chain through the page.
  const chrome = useBoardChrome(projectId, board?.id)
  const { setAssignee, showArchived, tasks, tasksQuery, view, visibleTasks } = chrome
  const { data: projects = [] } = useProjects()
  const moveTask = useMoveTask()
  // Agents' ticket work on this board: badges, card dots and the column menu.
  const { data: ticketWork } = useBoardTicketWork(projectId, board?.id)
  const [startWorkColumn, setStartWorkColumn] = useState<BoardColumnView | null>(null)
  useClearProjectAttention(projectId, 'task_assigned', tasksQuery.isSuccess && !tasksQuery.isStale)

  const isScrum = board?.style === 'scrum'
  const iterationsQuery = useIterations(isScrum ? projectId : undefined)
  const iterations = iterationsQuery.isPlaceholderData ? [] : iterationsQuery.data ?? []
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')

  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const columns: BoardColumnView[] = board?.columns ?? []

  const handleMove = (taskId: string, columnId: string, position: number) => {
    moveTask.mutate({ id: taskId, columnId, position })
  }

  if (!board) return null
  if (tasksQuery.isLoading || (isScrum && (iterationsQuery.isLoading || iterationsQuery.isPlaceholderData))) {
    return <Skeleton variant="board" />
  }
  if (isScrum && iterationsQuery.isError && !iterationsQuery.data) {
    return <QueryState errorLabel={t('board.sprintsError')} loadingLabel={t('board.loadingSprints')} query={iterationsQuery}>
      {() => null}
    </QueryState>
  }

  // A scrum board is a window on the active sprint; without one there is
  // nothing for it to show, and the remedy is planning a sprint.
  if (isScrum && !activeIteration) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-sm text-[color:var(--tx2)]">{t('board.noActiveSprint')}</div>
        <Link
          className="admin-button admin-button-primary"
          to={`/projects/${projectId}/backlog`}
        >
          {t('board.planSprint')}
        </Link>
      </div>
    )
  }

  return (
    // No bottom padding: the column tracks run to the window's bottom edge,
    // so the board reads as tracks running off the screen rather than panels
    // floating above a dead band. Top and sides keep their gutter.
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pt-4">
      {tasksQuery.isError && tasksQuery.data ? (
        <Notice role="alert" tone="warning">
          {t('board.refreshWarning')}{' '}
          <button className="underline" onClick={() => void tasksQuery.refetch()} type="button">{t('board.retry')}</button>
        </Notice>
      ) : null}
      {isScrum && activeIteration ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
          <span className="font-semibold uppercase tracking-[0.16em]">
            {activeIteration.name}
          </span>
          {activeIteration.goal ? <span>· {activeIteration.goal}</span> : null}
          <span>
            · {activeIteration.pointsDone}/{activeIteration.pointsTotal} pts
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {tasksQuery.isError && !tasksQuery.data ? (
          <QueryState errorLabel={t('board.tasksError')} loadingLabel={t('board.loadingTasks')} query={tasksQuery}>
            {() => null}
          </QueryState>
        ) : visibleTasks.length === 0 && tasks.length > 0 ? (
          // Empty columns under a filter would otherwise read as "nobody is
          // working on anything"; the board is not empty, this view is.
          <EmptyState
            action={
              <button
                className="admin-button"
                onClick={() => setAssignee(ALL_ASSIGNEES)}
                type="button"
              >
                {t('board.showAllAssignees')}
              </button>
            }
            title={t('board.noCardsForAssignee')}
          >
          {t('board.filteredEmptyDescription')}
          </EmptyState>
        ) : columns.length === 0 ? (
          <EmptyState
            action={
              <Link
                className="admin-button admin-button-primary"
                to={`/projects/${projectId}/boards/${board.id}/settings?tab=columns`}
              >
                {t('board.addColumns')}
              </Link>
            }
            title={t('board.noColumns')}
          >
            {t('board.noColumnsDescription')}
          </EmptyState>
        ) : (
          <KanbanBoard
            boardId={board.id}
            columns={columns}
            key={board.id}
            onMoveTask={handleMove}
            onOpenTask={onOpenTask}
            onStartWork={setStartWorkColumn}
            projectId={projectId}
            projectNameById={projectNameById}
            showArchived={showArchived}
            showProject={false}
            tasks={visibleTasks}
            ticketWork={ticketWork}
            view={view}
          />
        )}
      </div>
      {startWorkColumn ? (
        <BoardStartWorkDialog
          boardId={board.id}
          column={startWorkColumn}
          onClose={() => setStartWorkColumn(null)}
          projectId={projectId}
        />
      ) : null}
    </div>
  )
}
