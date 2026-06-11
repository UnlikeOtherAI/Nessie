import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { KanbanBoard } from '../components/kanban/KanbanBoard'
import { useProjects } from '../facades/projects/hooks'
import { useCreateTask, useTaskAssignees, useTasks } from '../facades/tasks/hooks'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const ProjectKanbanPage = () => {
  const { projectId } = useParams<{ projectId?: string }>()
  const { data: projects = [] } = useProjects()
  const tasksQuery = useTasks(projectId)
  const { data: assignees = [] } = useTaskAssignees()
  const createTask = useCreateTask()

  const [title, setTitle] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [formProjectId, setFormProjectId] = useState('')

  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects],
  )

  const currentProjectName = projectId ? projectNameById[projectId] ?? null : null
  const tasks = tasksQuery.data ?? []
  const canSubmit = title.trim().length > 0 && !createTask.isPending

  const handleCreate = () => {
    const targetProjectId = projectId ?? (formProjectId || undefined)
    createTask.mutate(
      {
        title: title.trim(),
        projectId: targetProjectId,
        assigneeUserId: assigneeUserId || undefined,
      },
      {
        onSuccess: () => {
          setTitle('')
          setAssigneeUserId('')
          setFormProjectId('')
        },
      },
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-3 border-b border-[color:var(--sep)] px-5">
        <div className={sectionTitle}>{currentProjectName ?? 'All projects'}</div>
        <span className="text-xs text-[color:var(--tx3)]">Kanban</span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <form
          className="admin-card flex flex-wrap items-center gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) handleCreate()
          }}
        >
          <input
            className="admin-input min-w-[200px] flex-1 py-1.5 text-sm"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New task…"
            value={title}
          />
          {projectId ? null : (
            <select
              className="admin-input max-w-[180px] py-1.5 text-sm"
              onChange={(event) => setFormProjectId(event.target.value)}
              value={formProjectId}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
          <select
            className="admin-input max-w-[180px] py-1.5 text-sm"
            onChange={(event) => setAssigneeUserId(event.target.value)}
            value={assigneeUserId}
          >
            <option value="">Unassigned</option>
            {assignees.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
          </select>
          <button
            className="admin-button admin-button-primary py-1.5"
            disabled={!canSubmit}
            type="submit"
          >
            Add task
          </button>
          {createTask.isError ? (
            <span className="text-xs text-[color:var(--danger-text)]">
              {(createTask.error as Error).message}
            </span>
          ) : null}
        </form>

        <div className="min-h-0 flex-1">
          {tasksQuery.isError ? (
            <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
              Failed to load tasks. Please refresh.
            </div>
          ) : (
            <KanbanBoard
              assignees={assignees}
              projectNameById={projectNameById}
              showProject={!projectId}
              tasks={tasks}
            />
          )}
        </div>
      </div>
    </section>
  )
}
