import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { KanbanBoard } from '../../components/features/projects/kanban/KanbanBoard'
import type { BoardColumnView } from '../../components/features/projects/kanban/kanban-config'
import type { BoardRecord } from '../../facades/boards/hooks'
import { useBoardTasks } from '../../facades/boards/hooks'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useCanAdministerProject } from '../../facades/projects/administration'
import { useMoveTask } from '../../facades/tasks/hooks'
import { useClearProjectAttention } from '../../facades/alerts/clear-project-attention'
import { useProjectSources } from '../../facades/board-sources/hooks'
import { SourceStatusStrip } from '../../components/features/projects/kanban/SourceStatusStrip'
import { EmptyState } from '../../components/shared/EmptyState'

type ProjectBoardTabProps = {
  board: BoardRecord | null
  projectId: string
}

export const ProjectBoardTab = ({ board, projectId }: ProjectBoardTabProps) => {
  const tasksQuery = useBoardTasks(projectId, board?.id)
  const { data: projects = [] } = useProjects()
  const { data: sources = [] } = useProjectSources(projectId)
  const canAdminister = useCanAdministerProject(projectId)
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
  const tasks = tasksQuery.data?.tasks ?? []

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
      <SourceStatusStrip
        canAdminister={canAdminister}
        projectId={projectId}
        sources={sources}
      />
      {tasksQuery.data?.truncated ? (
        <div className="text-xs text-[color:var(--tx3)]">
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
        ) : tasks.length === 0 && sources.length === 0 ? (
          <EmptyState
            action={
              <Link
                className="admin-button admin-button-primary"
                to={`/projects/${projectId}/settings?section=sources&connect=1`}
              >
                Connect a source
              </Link>
            }
            title="Nothing on this board yet."
          >
            New tasks appear in the first column — or bring in work from Jira, Linear,
            Trello or GitHub.
          </EmptyState>
        ) : columns.length === 0 ? (
          <EmptyState
            action={
              <Link
                className="admin-button admin-button-primary"
                to={`/projects/${projectId}/settings?section=boards&board=${board.id}`}
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
            onMoveTask={handleMove}
            projectId={projectId}
            projectNameById={projectNameById}
            showProject={false}
            tasks={tasks}
          />
        )}
      </div>
    </div>
  )
}
