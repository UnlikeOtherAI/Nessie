import { useState } from 'react'
import { useProjects } from '../../facades/projects/hooks'
import { useCreateTask, useTaskAssignees } from '../../facades/tasks/hooks'

type NewTaskBarProps = {
  // When set, new tasks belong to this project; otherwise a project picker is shown.
  projectId?: string
  // When set (scrum board), new tasks land in this iteration.
  iterationId?: string
}

export const NewTaskBar = ({ projectId, iterationId }: NewTaskBarProps) => {
  const { data: projects = [] } = useProjects()
  const { data: assignees = [] } = useTaskAssignees()
  const createTask = useCreateTask()

  const [title, setTitle] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [formProjectId, setFormProjectId] = useState('')

  const canSubmit = title.trim().length > 0 && !createTask.isPending

  const handleCreate = () => {
    createTask.mutate(
      {
        title: title.trim(),
        projectId: projectId ?? (formProjectId || undefined),
        iterationId: iterationId || undefined,
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
      <button className="admin-button admin-button-primary py-1.5" disabled={!canSubmit} type="submit">
        Add task
      </button>
      {createTask.isError ? (
        <span className="text-xs text-[color:var(--danger-text)]">
          {(createTask.error as Error).message}
        </span>
      ) : null}
    </form>
  )
}
