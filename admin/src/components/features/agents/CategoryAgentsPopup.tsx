import { useMemo, useState } from 'react'
import {
  useAddAgentToCategory,
  useRemoveAgentFromCategory,
} from '../../../facades/agent-categories/hooks'
import type { AgentCategoryRecord, AgentRecord } from '../../../lib/api-client'

type CategoryAgentsPopupProps = {
  allAgents: AgentRecord[]
  category: AgentCategoryRecord
  onClose: () => void
}

const agentGradient = 'linear-gradient(135deg,#7c3aed,#6d28d9)'

const getAgentGlyph = (role: string): string => {
  const lower = role.toLowerCase()
  if (lower.includes('research')) return '\u{1F50D}'
  if (lower.includes('write')) return '\u{1F4DD}'
  return '\u26A1'
}

const rowClass = [
  'flex items-center gap-3 rounded-lg px-3 py-2',
  'hover:bg-white/5 transition-colors',
].join(' ')

const actionBtnClass = [
  'flex h-7 items-center justify-center rounded px-2',
  'text-xs font-medium transition-colors',
].join(' ')

export const CategoryAgentsPopup = ({
  allAgents,
  category,
  onClose,
}: CategoryAgentsPopupProps) => {
  const [search, setSearch] = useState('')

  const addAgent = useAddAgentToCategory()
  const removeAgent = useRemoveAgentFromCategory()

  const categoryAgentIds = useMemo(
    () => new Set(category.agentIds),
    [category.agentIds],
  )

  const lowerSearch = search.toLowerCase().trim()

  const boundAgents = useMemo(
    () =>
      allAgents.filter(
        (a) =>
          categoryAgentIds.has(a.id) &&
          (!lowerSearch ||
            a.name.toLowerCase().includes(lowerSearch) ||
            a.role.toLowerCase().includes(lowerSearch)),
      ),
    [allAgents, categoryAgentIds, lowerSearch],
  )

  const availableAgents = useMemo(
    () =>
      allAgents.filter(
        (a) =>
          !a.parentAgentId &&
          !categoryAgentIds.has(a.id) &&
          (!lowerSearch ||
            a.name.toLowerCase().includes(lowerSearch) ||
            a.role.toLowerCase().includes(lowerSearch)),
      ),
    [allAgents, categoryAgentIds, lowerSearch],
  )

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
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
        className={[
          'flex max-h-[80vh] w-full max-w-[480px] flex-col',
          'rounded-xl border border-[color:var(--sep)]',
          'bg-[color:var(--main)]',
        ].join(' ')}
        style={{ boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}
      >
        {/* Header */}
        <div
          className={[
            'flex items-center justify-between',
            'border-b border-[color:var(--sep)] px-5 py-4',
          ].join(' ')}
        >
          <div>
            <h2 className="text-lg font-bold text-white">
              {category.name}
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {boundAgents.length} agent
              {boundAgents.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center rounded',
              'text-[color:var(--tx3)] hover:bg-white/10 hover:text-white',
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

        {/* Search */}
        <div className="border-b border-[color:var(--sep)] px-5 py-3">
          <div
            className={[
              'flex items-center gap-2 rounded-lg',
              'border border-[color:var(--border-strong)]',
              'bg-white/5 px-3 py-2',
            ].join(' ')}
          >
            <svg
              className={[
                'h-4 w-4 flex-shrink-0',
                'text-[color:var(--tx3)]',
              ].join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <input
              autoFocus
              className={[
                'w-full bg-transparent text-sm',
                'text-[color:var(--tx)] outline-none',
                'placeholder:text-[color:var(--tx3)]',
              ].join(' ')}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents..."
              value={search}
            />
          </div>
        </div>

        {/* Scrollable list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {/* Current agents in category */}
          {boundAgents.length > 0 && (
            <div>
              <div
                className={[
                  'px-3 py-1.5 text-[11px] font-semibold',
                  'uppercase tracking-[0.16em]',
                  'text-[color:var(--tx3)]',
                ].join(' ')}
              >
                In this category
              </div>

              {boundAgents.map((agent) => (
                <div className={rowClass} key={agent.id}>
                  <div
                    className={[
                      'flex h-8 w-8 flex-shrink-0',
                      'items-center justify-center',
                      'rounded-full text-sm',
                    ].join(' ')}
                    style={{ background: agentGradient }}
                  >
                    {getAgentGlyph(agent.role)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={[
                        'truncate text-sm font-medium text-white',
                      ].join(' ')}
                    >
                      {agent.name}
                    </div>
                    <div
                      className="truncate text-xs text-[color:var(--tx3)]"
                    >
                      {agent.role}
                    </div>
                  </div>
                  <span
                    className={[
                      'rounded border border-[rgba(124,58,237,0.3)]',
                      'bg-[rgba(124,58,237,0.15)] px-1.5 py-0.5',
                      'text-[10px] font-semibold uppercase',
                      'tracking-[0.12em] text-[#a78bfa]',
                    ].join(' ')}
                  >
                    agent
                  </span>
                  <button
                    className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-red-500/10 hover:text-red-400`}
                    disabled={removeAgent.isPending}
                    onClick={() =>
                      removeAgent.mutate({
                        agentId: agent.id,
                        categoryId: category.id,
                      })
                    }
                    title="Remove from category"
                    type="button"
                  >
                    <svg
                      className="h-3.5 w-3.5"
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
              ))}
            </div>
          )}

          {/* Available agents to add */}
          {availableAgents.length > 0 && (
            <div className="mt-2">
              <div
                className={[
                  'px-3 py-1.5 text-[11px] font-semibold',
                  'uppercase tracking-[0.16em]',
                  'text-[color:var(--tx3)]',
                ].join(' ')}
              >
                Add to category
              </div>

              {availableAgents.map((agent) => (
                <div className={rowClass} key={agent.id}>
                  <div
                    className={[
                      'flex h-8 w-8 flex-shrink-0',
                      'items-center justify-center',
                      'rounded-full text-sm opacity-60',
                    ].join(' ')}
                    style={{ background: agentGradient }}
                  >
                    {getAgentGlyph(agent.role)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-sm text-[color:var(--tx2)]"
                    >
                      {agent.name}
                    </div>
                    <div
                      className="truncate text-xs text-[color:var(--tx3)]"
                    >
                      {agent.role}
                    </div>
                  </div>
                  <button
                    className={[
                      actionBtnClass,
                      'border border-[rgba(124,58,237,0.3)]',
                      'text-[#a78bfa]',
                      'hover:bg-[rgba(124,58,237,0.15)]',
                    ].join(' ')}
                    disabled={addAgent.isPending}
                    onClick={() =>
                      addAgent.mutate({
                        agentId: agent.id,
                        categoryId: category.id,
                      })
                    }
                    type="button"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}

          {boundAgents.length === 0 && availableAgents.length === 0 && (
            <div
              className={[
                'px-3 py-6 text-center text-sm',
                'text-[color:var(--tx3)]',
              ].join(' ')}
            >
              No agents match your search.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
