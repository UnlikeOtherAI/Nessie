import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { KanbanBoard } from '../../components/kanban/KanbanBoard'
import type { BoardColumnView } from '../../components/kanban/kanban-config'
import { useProjectBoard } from '../../facades/board/hooks'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useMoveTask, useTasks } from '../../facades/tasks/hooks'

type ProjectBoardTabProps = {
  projectId: string
}

export const ProjectBoardTab = ({ projectId }: ProjectBoardTabProps) => {
  const boardQuery = useProjectBoard(projectId)
  const tasksQuery = useTasks(projectId)
  const { data: projects = [] } = useProjects()
  const moveTask = useMoveTask()

  const isScrum = boardQuery.data?.style === 'scrum'
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')

  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const columns: BoardColumnView[] = boardQuery.data?.columns ?? []
  const allTasks = tasksQuery.data ?? []
  // Scrum boards show only the active sprint's work; Kanban shows everything.
  const tasks = isScrum
    ? allTasks.filter((task) => task.iterationId === activeIteration?.id)
    : allTasks

  const handleMove = (taskId: string, columnId: string, position: number) => {
    moveTask.mutate({ id: taskId, columnId, position })
  }

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
      <div className="min-h-0 flex-1">
        {tasksQuery.isError ? (
          <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
            Failed to load tasks. Please refresh.
          </div>
        ) : (
          <KanbanBoard
            columns={columns}
            onMoveTask={handleMove}
            projectNameById={projectNameById}
            showProject={false}
            tasks={tasks}
          />
        )}
      </div>
    </div>
  )
}
