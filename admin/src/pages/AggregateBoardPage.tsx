import { useMemo } from 'react'
import { KanbanBoard } from '../components/kanban/KanbanBoard'
import { NewTaskButton } from '../components/kanban/NewTaskButton'
import {
  AGGREGATE_COLUMNS,
  CATEGORY_TO_STATUS,
  type BoardColumnView,
} from '../components/kanban/kanban-config'
import { useProjects } from '../facades/projects/hooks'
import { useTasks, useTransitionTask } from '../facades/tasks/hooks'
import type { ColumnCategory } from '../facades/board/hooks'
import { MobileMenuButton } from '../layouts/admin-shell/MobileMenuButton'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

// The all-projects board: synthetic category columns, dragging maps to a
// status transition (there is no single per-project column set to pin to).
export const AggregateBoardPage = () => {
  const { data: projects = [] } = useProjects()
  const tasksQuery = useTasks()
  const transition = useTransitionTask()

  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const handleMove = (taskId: string, columnId: string) => {
    transition.mutate({ id: taskId, status: CATEGORY_TO_STATUS[columnId as ColumnCategory] })
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-3 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className={sectionTitle}>All projects</div>
        <span className="text-xs text-[color:var(--tx3)]">Kanban</span>
        <div className="ml-auto">
          <NewTaskButton />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="min-h-0 flex-1">
          {tasksQuery.isError ? (
            <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
              Failed to load tasks. Please refresh.
            </div>
          ) : (
            <KanbanBoard
              columns={AGGREGATE_COLUMNS as BoardColumnView[]}
              onMoveTask={handleMove}
              projectNameById={projectNameById}
              showProject
              tasks={tasksQuery.data ?? []}
            />
          )}
        </div>
      </div>
    </section>
  )
}
