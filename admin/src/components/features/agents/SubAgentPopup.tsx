import { useState } from 'react'
import type { AgentChild } from '@nessie/schemas'
import { useAgentChildren, useCreateAgent } from '../../../facades/agents/hooks'
import { AgentStatusDot } from './AgentStatusDot'

type SubAgentPopupProps = {
  onClose: () => void
  parentAgentId: string
  parentAgentName: string
}

const agentGradient = 'linear-gradient(135deg,#7c3aed,#6d28d9)'

const getAgentGlyph = (status: AgentChild['status']): string => {
  if (status === 'executing' || status === 'thinking') return '\u26A1'
  if (status === 'error') return '\u26A0'
  return '\u{1F916}'
}

const rowClass = [
  'flex items-center gap-3 rounded-lg px-3 py-2',
  'hover:bg-white/5 transition-colors',
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

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

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
      <div
        className="flex max-h-[80vh] w-full max-w-[480px] flex-col rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)]"
        style={{ boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-white">
              Sub-agents of {parentAgentName}
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {children.length} sub-agent{children.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-white/10 hover:text-white"
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

        {/* Scrollable list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {children.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                Current sub-agents
              </div>

              {children.map((child) => (
                <div className={rowClass} key={child.agentId}>
                  <div
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm"
                    style={{ background: agentGradient }}
                  >
                    {getAgentGlyph(child.status)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">
                        {child.name}
                      </span>
                      <AgentStatusDot status={child.status} />
                    </div>
                    {child.purpose && (
                      <div className="truncate text-xs text-[color:var(--tx3)]">
                        {child.purpose}
                      </div>
                    )}
                  </div>
                  <span className="rounded border border-[rgba(124,58,237,0.3)] bg-[rgba(124,58,237,0.15)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a78bfa]">
                    agent
                  </span>
                </div>
              ))}
            </div>
          )}

          {children.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
              No sub-agents yet.
            </div>
          )}

          {/* Create sub-agent */}
          <div className="mt-2 border-t border-[color:var(--sep)] pt-2">
            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              Create sub-agent
            </div>

            <div className="space-y-2 px-3 py-2">
              <input
                className="w-full rounded-lg border border-[color:var(--border-strong)] bg-white/5 px-3 py-2 text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)] focus:border-[#7c3aed]"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Agent name"
                value={name}
              />
              <input
                className="w-full rounded-lg border border-[color:var(--border-strong)] bg-white/5 px-3 py-2 text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)] focus:border-[#7c3aed]"
                onChange={(e) => setRole(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Role (default: assistant)"
                value={role}
              />
              <button
                className="flex w-full items-center justify-center rounded-lg border border-[rgba(124,58,237,0.3)] bg-[rgba(124,58,237,0.15)] px-3 py-2 text-sm font-medium text-[#a78bfa] transition-colors hover:bg-[rgba(124,58,237,0.25)] disabled:opacity-40"
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
