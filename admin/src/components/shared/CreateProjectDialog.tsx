import { useRef, useState, type FormEvent } from 'react'
import { useCreateProject, useCreateTeam } from '../../facades/projects/hooks'
import { Dialog } from './Dialog'

type CreateProjectDialogProps = {
  onClose: () => void
  open: boolean
}

export const CreateProjectDialog = ({ onClose, open }: CreateProjectDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createProject = useCreateProject()
  const createTeam = useCreateTeam()
  const [name, setName] = useState('')

  const handleClose = () => {
    setName('')
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return

    const project = await createProject.mutateAsync({ name: trimmedName })
    await createTeam.mutateAsync({
      name: `${trimmedName} Team`,
      projectId: project.id,
    })
    handleClose()
  }

  return (
    <Dialog
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      title="Create a project"
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="project-name"
          >
            Name
          </label>
          <input
            ref={nameInputRef}
            autoComplete="off"
            className="admin-input"
            id="project-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. product-launch"
            value={name}
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || createProject.isPending || createTeam.isPending}
            type="submit"
          >
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  )
}
