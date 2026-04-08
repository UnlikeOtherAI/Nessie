import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useCreateAgent } from '../../../facades/agents/hooks'

type CreateAgentDialogProps = {
  onClose: () => void
  open: boolean
}

export const CreateAgentDialog = ({
  onClose,
  open,
}: CreateAgentDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createAgent = useCreateAgent()

  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')

  useEffect(() => {
    if (open) {
      nameInputRef.current?.focus()
    }
  }, [open])

  const handleClose = () => {
    setName('')
    setRole('')
    setSystemPrompt('')
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

    await createAgent.mutateAsync({
      name: name.trim(),
      role: role.trim() || 'assistant',
      systemPrompt: systemPrompt.trim() || undefined,
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
            New agent
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
              htmlFor="agent-name"
            >
              Name
            </label>
            <input
              ref={nameInputRef}
              autoComplete="off"
              className="admin-input"
              id="agent-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Code Reviewer"
              value={name}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="agent-role"
            >
              Role
            </label>
            <input
              autoComplete="off"
              className="admin-input"
              id="agent-role"
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. assistant, reviewer, analyst"
              value={role}
            />
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="agent-system-prompt"
            >
              System prompt
            </label>
            <textarea
              autoComplete="off"
              className="admin-input resize-none"
              id="agent-system-prompt"
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Instructions for the agent (optional)"
              rows={4}
              value={systemPrompt}
            />
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
              disabled={!name.trim() || createAgent.isPending}
              type="submit"
            >
              {createAgent.isPending ? 'Creating...' : 'Create agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
