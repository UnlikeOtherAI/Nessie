import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAgents } from '../../../facades/agents/hooks'
import { useModalA11y } from '../../shared/useModalA11y'
import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import type { KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'
import { AgentMemberChecklist } from './AgentMemberChecklist'

type SpaceSettingsDialogProps = {
  onClose: () => void
  onSave: (input: { name: string; description: string | null; memberAgentIds: string[] }) => Promise<void>
  open: boolean
  pending?: boolean
  space: KnowledgeSpaceRecord
}

// Minimal space settings surface: rename, redescribe, and retag which agents
// are members of the space. Agent membership is what grants an agent read
// (and, subject to writeRestricted, write) access to private/channel/team
// scoped spaces — this is how the Librarian agent gets tagged in.
export const SpaceSettingsDialog = ({
  onClose,
  onSave,
  open,
  pending,
  space,
}: SpaceSettingsDialogProps) => {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useModalA11y(dialogRef, onClose)
  const overlayDismiss = useOverlayDismiss(onClose)
  const agentsQuery = useAgents()

  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [memberAgentIds, setMemberAgentIds] = useState<string[]>(space.memberAgentIds)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(space.name)
      setDescription(space.description ?? '')
      setMemberAgentIds(space.memberAgentIds)
      setFormError(null)
    }
  }, [open, space])

  if (!open) return null

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    try {
      await onSave({
        name: trimmedName,
        description: description.trim() ? description.trim() : null,
        memberAgentIds,
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save space.')
    }
  }

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
      <div
        aria-labelledby="space-settings-title"
        aria-modal="true"
        className="create-channel-panel"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-[color:var(--tx)]" id="space-settings-title">
            Space settings
          </h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={onClose}
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
              htmlFor="space-settings-name"
            >
              Name
            </label>
            <input
              autoComplete="off"
              className="admin-input"
              id="space-settings-name"
              onChange={(event) => {
                setName(event.target.value)
                setFormError(null)
              }}
              value={name}
            />
            {formError ? (
              <div className="text-xs text-[color:var(--danger-text)]">{formError}</div>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <label
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
              htmlFor="space-settings-description"
            >
              Description
            </label>
            <textarea
              className="admin-input"
              id="space-settings-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional description"
              rows={3}
              value={description}
            />
          </div>

          <div className="grid gap-1.5">
            <span
              className={[
                'text-xs font-semibold uppercase',
                'tracking-[0.16em] text-[color:var(--tx3)]',
              ].join(' ')}
            >
              Agents tagged in
            </span>
            <AgentMemberChecklist
              agents={agentsQuery.data ?? []}
              onChange={setMemberAgentIds}
              selectedAgentIds={memberAgentIds}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="admin-button admin-button-primary"
              disabled={!name.trim() || pending}
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
