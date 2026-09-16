import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { KanbanBoard } from '../../components/features/projects/kanban/KanbanBoard'
import { ALL_ASSIGNEES } from '../../components/features/projects/kanban/board-assignee-filter'
import type { BoardColumnView } from '../../components/features/projects/kanban/kanban-config'
import type { BoardRecord, BoardTaskRecord } from '../../facades/boards/hooks'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useCanModifyProject } from '../../facades/projects/administration'
import { useMoveTask } from '../../facades/tasks/hooks'
import { useClearProjectAttention } from '../../facades/alerts/clear-project-attention'
import { useProjectSources } from '../../facades/board-sources/hooks'
import { SourceStatusStrip } from '../../components/features/projects/kanban/SourceStatusStrip'
import { EmptyState } from '../../components/shared/EmptyState'
import { useBoardChrome } from './useBoardChrome'

type ProjectBoardTabProps = {
  board: BoardRecord | null
  onOpenTask: (task: BoardTaskRecord) => void
  projectId: string
}

export const ProjectBoardTab = ({ board, onOpenTask, projectId }: ProjectBoardTabProps) => {
  // The header owns the controls; this owns the board. Both read the same URL
  // and the same query cache through `useBoardChrome`, so there is one answer
  // to what is on screen rather than a prop chain through the page.
  const chrome = useBoardChrome(projectId, board?.id)
  const { setAssignee, showArchived, tasks, tasksQuery, view, visibleTasks } = chrome
  const { data: projects = [] } = useProjects()
  const { data: sources = [] } = useProjectSources(projectId, board?.id)
  const canAdminister = useCanModifyProject(projectId)
  const moveTask = useMoveTask()
  useClearProjectAttention(projectId, 'task_assigned', tasksQuery.isSuccess)

  const isScrum = board?.style === 'scrum'
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
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

  // A scrum board is a window on the active sprint; without one there is
  // nothing for it to show, and the remedy is planning a sprint.
  if (isScrum && !activeIteration) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-sm text-[color:var(--tx2)]">No active sprint.</div>
        <Link
          className="admin-button admin-button-primary"
          to={`/projects/${projectId}/backlog`}
        >
          Plan a sprint
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
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
      {/* Health, not a control: it renders nothing until a connected source
          has something to say, and its remedy is one press from the board.
          The controls that used to share this row are in the header. */}
      <SourceStatusStrip
        canAdminister={canAdminister}
        projectId={projectId}
        sources={sources}
      />
      {tasksQuery.data?.truncated ? (
        <div className="text-xs text-[color:var(--tx3)]">
          {/* The cap is on the board read, so it bounds what any filter can
              possibly match — say so before somebody reads an empty column as
              "nobody is working on this". */}
          Showing the 500 most recently updated cards.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* Not QueryState: the recovery here is "Please refresh.", not a Retry
            button, and there is no loading or empty state to share. */}
        {tasksQuery.isError ? (
          <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
            Failed to load tasks. Please refresh.
          </div>
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
                Show all assignees
              </button>
            }
            title="No cards for this assignee."
          >
            This board has {tasks.length} {tasks.length === 1 ? 'card' : 'cards'}, none
            of them assigned to whoever the filter names.
          </EmptyState>
        ) : columns.length === 0 ? (
          <EmptyState
            action={
              <Link
                className="admin-button admin-button-primary"
                to={`/projects/${projectId}/boards/${board.id}/settings?tab=columns`}
              >
                Add columns
              </Link>
            }
            title="This board has no columns yet."
          >
            Add a column for each stage this board should show.
          </EmptyState>
        ) : (
          <KanbanBoard
            boardId={board.id}
            columns={columns}
            key={board.id}
            onMoveTask={handleMove}
            onOpenTask={onOpenTask}
            projectId={projectId}
            projectNameById={projectNameById}
            showArchived={showArchived}
            showProject={false}
            tasks={visibleTasks}
            view={view}
          />
        )}
      </div>
    </div>
  )
}
