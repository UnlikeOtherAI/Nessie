import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useCreateAgentCategory } from '../../../facades/agent-categories/hooks'

type CreateCategoryDialogProps = {
  onClose: () => void
  open: boolean
}

export const CreateCategoryDialog = ({
  onClose,
  open,
}: CreateCategoryDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createCategory = useCreateAgentCategory()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'public'>('public')

  useEffect(() => {
    if (open) {
      nameInputRef.current?.focus()
    }
  }, [open])

  const handleClose = () => {
    setName('')
    setDescription('')
    setVisibility('public')
    onClose()
  }

  const handleOverlayClick = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (event.target === event.currentTarget) {
      handleClose()
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) return

    await createCategory.mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
      visibility,
    })
    handleClose()
  }

  if (!open) return null

  return (
    <div
      onClick={handleOverlayClick}
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div className="create-channel-panel">
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-white">
            New agent category
          </h2>
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
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
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
              htmlFor="category-name"
            >
              Name
            </label>
            <input
              ref={nameInputRef}
              autoComplete="off"
              className="admin-input"
              id="category-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Code Reviewers"
              value={name}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="category-description"
            >
              Description
            </label>
            <textarea
              autoComplete="off"
              className="admin-input resize-none"
              id="category-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this category for?"
              rows={3}
              value={description}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="category-visibility"
            >
              Visibility
            </label>
            <select
              className="admin-input"
              id="category-visibility"
              onChange={(e) =>
                setVisibility(e.target.value as 'private' | 'public')
              }
              value={visibility}
            >
              <option value="public">Global</option>
              <option value="private">Private</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="admin-button admin-button-secondary"
              onClick={handleClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={!name.trim() || createCategory.isPending}
              type="submit"
            >
              {createCategory.isPending ? 'Creating...' : 'Create category'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
