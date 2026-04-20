import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRenameProject } from '../../facades/projects/hooks'

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

  useEffect(() => {
    if (open) {
      setName(currentName)
      nameInputRef.current?.focus()
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

  if (!open) return null

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleClose()
        }
      }}
      role="presentation"
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 9999,
      }}
    >
      <div className="create-channel-panel">
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-white">Rename project</h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-white/10 hover:text-white',
            ].join(' ')}
            onClick={handleClose}
            type="button"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

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
      </div>
    </div>
  )
}
