import { useEffect, useRef, useState, type FormEvent } from 'react'

type CreateSpaceDialogProps = {
  onClose: () => void
  onCreate: (name: string) => Promise<void> | void
  open: boolean
  pending?: boolean
}

export const CreateSpaceDialog = ({ onClose, onCreate, open, pending }: CreateSpaceDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) {
      nameInputRef.current?.focus()
    }
  }, [open])

  const handleClose = () => {
    setName('')
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    await onCreate(trimmedName)
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
        background: 'var(--scrim-strong)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 9999,
      }}
    >
      <div className="create-channel-panel">
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-[color:var(--tx)]">Create a space</h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
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
              htmlFor="space-name"
            >
              Name
            </label>
            <input
              ref={nameInputRef}
              autoComplete="off"
              className="admin-input"
              id="space-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Engineering"
              value={name}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
              Cancel
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={!name.trim() || pending}
              type="submit"
            >
              Create space
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
