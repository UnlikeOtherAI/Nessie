import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRenameProject } from '../../facades/projects/hooks'
import { Dialog } from './Dialog'

type RenameProjectDialogProps = {
  currentName: string
  onClose: () => void
  open: boolean
  projectId: string
}

export const RenameProjectDialog = (
  { currentName, onClose, open, projectId }: RenameProjectDialogProps,
) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const renameProject = useRenameProject()
  const [name, setName] = useState(currentName)

  // Focus is the Dialog's job now (`initialFocusRef`); reseeding the field when
  // the dialog opens on a different project is still this component's.
  useEffect(() => {
    if (open) {
      setName(currentName)
    }
  }, [currentName, open])

  const handleClose = () => {
    setName(currentName)
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === currentName) {
      handleClose()
      return
    }

    await renameProject.mutateAsync({ name: trimmedName, projectId })
    handleClose()
  }

  return (
    <Dialog
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      title="Rename project"
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="rename-project-name"
          >
            Name
          </label>
          <input
            ref={nameInputRef}
            autoComplete="off"
            className="admin-input"
            id="rename-project-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || renameProject.isPending}
            type="submit"
          >
            Rename project
          </button>
        </div>
      </form>
    </Dialog>
  )
}
