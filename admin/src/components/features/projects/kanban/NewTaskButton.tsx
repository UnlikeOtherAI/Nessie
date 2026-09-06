import { useState } from 'react'
import { TaskDialog } from './TaskDialog'

type NewTaskButtonProps = {
  // When set, new tasks belong to this project; otherwise the dialog shows a picker.
  projectId?: string
  // When set (scrum board), new tasks land in this iteration.
  iterationId?: string
}

// The "new task" affordance opens the very same dialog used to edit a task, so
// creating and editing share one form.
export const NewTaskButton = ({ projectId, iterationId }: NewTaskButtonProps) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="self-start">
      <button className="admin-button admin-button-primary" onClick={() => setOpen(true)} type="button">
        + New task
      </button>
      <TaskDialog
        iterationId={iterationId}
        onClose={() => setOpen(false)}
        open={open}
        projectId={projectId}
      />
    </div>
  )
}
