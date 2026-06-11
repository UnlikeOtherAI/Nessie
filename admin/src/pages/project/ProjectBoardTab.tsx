import { useMemo } from 'react'
import { KanbanBoard } from '../../components/kanban/KanbanBoard'
import { NewTaskBar } from '../../components/kanban/NewTaskBar'
import type { BoardColumnView } from '../../components/kanban/kanban-config'
import { useProjectBoard } from '../../facades/board/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useMoveTask, useTaskAssignees, useTasks } from '../../facades/tasks/hooks'

type ProjectBoardTabProps = {
  projectId: string
}

export const ProjectBoardTab = ({ projectId }: ProjectBoardTabProps) => {
  const boardQuery = useProjectBoard(projectId)
  const tasksQuery = useTasks(projectId)
  const { data: assignees = [] } = useTaskAssignees()
  const { data: projects = [] } = useProjects()
  const moveTask = useMoveTask()

  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const columns: BoardColumnView[] = boardQuery.data?.columns ?? []

  const handleMove = (taskId: string, columnId: string) => {
    moveTask.mutate({ id: taskId, columnId })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <NewTaskBar projectId={projectId} />
      <div className="min-h-0 flex-1">
        {tasksQuery.isError ? (
          <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
            Failed to load tasks. Please refresh.
          </div>
        ) : (
          <KanbanBoard
            assignees={assignees}
            columns={columns}
            onMoveTask={handleMove}
            projectNameById={projectNameById}
            showProject={false}
            tasks={tasksQuery.data ?? []}
          />
        )}
      </div>
    </div>
  )
}
