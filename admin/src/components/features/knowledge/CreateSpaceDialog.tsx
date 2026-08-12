import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAgents } from '../../../facades/agents/hooks'
import type { KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'
import { AgentMemberChecklist } from './AgentMemberChecklist'
import { useOverlayDismiss } from '../../shared/useOverlayDismiss'

type SpaceVisibility = KnowledgeSpaceRecord['visibility']

type CreateSpaceDialogProps = {
  onClose: () => void
  onCreate: (
    name: string,
    memberAgentIds: string[],
    visibility: SpaceVisibility,
  ) => Promise<void> | void
  open: boolean
  pending?: boolean
}

const VISIBILITY_OPTIONS: { value: SpaceVisibility; label: string; description: string }[] = [
  { value: 'private', label: 'Private', description: 'Only you and people or agents you add' },
  { value: 'channel', label: 'Channel', description: 'Everyone in a channel you pick' },
  { value: 'team', label: 'Team', description: 'Everyone on your team' },
  { value: 'project', label: 'Project', description: 'Everyone on the project' },
  { value: 'organization', label: 'Organization', description: 'Everyone in the organization' },
]

export const CreateSpaceDialog = ({ onClose, onCreate, open, pending }: CreateSpaceDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [memberAgentIds, setMemberAgentIds] = useState<string[]>([])
  const [visibility, setVisibility] = useState<SpaceVisibility>('private')
  const agentsQuery = useAgents()

  useEffect(() => {
    if (open) {
      nameInputRef.current?.focus()
    }
  }, [open])

  const handleClose = () => {
    setName('')
    setMemberAgentIds([])
    setVisibility('private')
    onClose()
  }

  const overlayDismiss = useOverlayDismiss(handleClose)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    await onCreate(trimmedName, memberAgentIds, visibility)
    handleClose()
  }

  if (!open) return null

  return (
    <div
      {...overlayDismiss}
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

          <div className="grid gap-1.5">
            <span
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
            >
              Visibility
            </span>
            <div className="grid gap-1.5">
              {VISIBILITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={[
                    'flex flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors',
                    visibility === option.value
                      ? 'bg-[color:var(--overlay)] ring-1 ring-inset ring-[color:var(--accent)]'
                      : 'bg-[color:var(--overlay-weak)] hover:bg-[color:var(--overlay)]',
                  ].join(' ')}
                  onClick={() => setVisibility(option.value)}
                  type="button"
                >
                  <span className="text-sm font-semibold text-[color:var(--tx)]">{option.label}</span>
                  <span className="text-xs text-[color:var(--tx3)]">{option.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <span
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
            >
              Agents
            </span>
            <AgentMemberChecklist
              agents={agentsQuery.data ?? []}
              onChange={setMemberAgentIds}
              selectedAgentIds={memberAgentIds}
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
