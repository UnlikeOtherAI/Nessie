import { useState } from 'react'
import type { AgentChild } from '@nessie/schemas'
import { useAgentChildren, useCreateAgent } from '../../../facades/agents/hooks'
import { AgentStatusDot } from './AgentStatusDot'
import { agentGradient } from '../../../lib/avatar'
import { useOverlayDismiss } from '../../shared/useOverlayDismiss'

type SubAgentPopupProps = {
  onClose: () => void
  parentAgentId: string
  parentAgentName: string
}

const getAgentGlyph = (status: AgentChild['status']): string => {
  if (status === 'executing' || status === 'thinking') return '\u26A1'
  if (status === 'error') return '\u26A0'
  return '\u{1F916}'
}

const rowClass = [
  'rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3',
  'transition hover:bg-[var(--scrim)]',
].join(' ')

export const SubAgentPopup = ({
  onClose,
  parentAgentId,
  parentAgentName,
}: SubAgentPopupProps) => {
  const { data: children = [] } = useAgentChildren(parentAgentId)
  const createAgent = useCreateAgent()

  const [name, setName] = useState('')
  const [role, setRole] = useState('')

  const overlayDismiss = useOverlayDismiss(onClose)

  const handleCreate = () => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    createAgent.mutate(
      {
        name: trimmedName,
        parentAgentId,
        role: role.trim() || 'assistant',
      },
      {
        onSuccess: () => {
          setName('')
          setRole('')
        },
      },
    )
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && name.trim()) {
      handleCreate()
    }
  }

  return (
    <div
      {...overlayDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--scrim-strong)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className={[
          'flex max-h-[80vh] w-full max-w-[480px] flex-col rounded-xl border',
          'border-[color:var(--sep)] bg-[color:var(--main)]',
        ].join(' ')}
        style={{ boxShadow: '0 24px 48px var(--scrim-strong)' }}
      >
        <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-[var(--tx)]">
              Team under {parentAgentName}
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {children.length} team member{children.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
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
              <path
                d="M6 18L18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {children.length > 0 ? (
            <div className="grid gap-3">
              {children.map((child) => (
                <div className={rowClass} key={child.agentId}>
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm"
                      style={{ background: agentGradient }}
                    >
                      {getAgentGlyph(child.status)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-[var(--tx)]">
                          {child.name}
                        </span>
                        <AgentStatusDot status={child.status} />
                      </div>
                      <div className="truncate text-xs text-[color:var(--tx3)]">
                        {child.purpose ?? 'assistant'}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                      {child.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
              No team members yet.
            </div>
          )}

          <div className="mt-4 rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
              Add team member
            </div>
            <div className="mt-3 space-y-2">
              <input
                className={[
                  'w-full rounded-lg border border-[color:var(--border-strong)] bg-[var(--overlay-weak)]',
                  'px-3 py-2 text-sm text-[color:var(--tx)] outline-none',
                  'placeholder:text-[color:var(--tx3)] focus:border-[var(--accent)]',
                ].join(' ')}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Agent name"
                value={name}
              />
              <input
                className={[
                  'w-full rounded-lg border border-[color:var(--border-strong)] bg-[var(--overlay-weak)]',
                  'px-3 py-2 text-sm text-[color:var(--tx)] outline-none',
                  'placeholder:text-[color:var(--tx3)] focus:border-[var(--accent)]',
                ].join(' ')}
                onChange={(e) => setRole(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Role (default: assistant)"
                value={role}
              />
              <button
                className="admin-button admin-button-primary"
                disabled={!name.trim() || createAgent.isPending}
                onClick={handleCreate}
                type="button"
              >
                {createAgent.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
