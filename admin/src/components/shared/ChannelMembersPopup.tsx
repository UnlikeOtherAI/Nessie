import { useMemo, useState } from 'react'
import type { AgentRecord, UserRecord } from '../../lib/api-client'
import { useAddChannelMember, useRemoveChannelMember } from '../../facades/channels/hooks'
import { useBindAgent, useCloneAgent, useUnbindAgent } from '../../facades/agents/hooks'
import { agentGradient, getInitials, pickGradient } from '../../lib/avatar'

type ChannelMembersPopupProps = {
  allAgents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channelId: string
  channelLabel: string
  channelType: 'dm' | 'standard'
  channelUsers: UserRecord[]
  currentUserId: string
  onClose: () => void
  onGroupCreated: (channelId: string) => void
  onSelectAgent: (agentId: string) => void
}

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

export const ChannelMembersPopup = ({
  allAgents,
  allUsers,
  boundAgents,
  channelId,
  channelLabel,
  channelType,
  channelUsers,
  currentUserId,
  onClose,
  onGroupCreated,
  onSelectAgent,
}: ChannelMembersPopupProps) => {
  const [search, setSearch] = useState('')

  const addMember = useAddChannelMember()
  const removeMember = useRemoveChannelMember()
  const bindAgent = useBindAgent()
  const unbindAgent = useUnbindAgent()
  const cloneAgent = useCloneAgent()

  const channelUserIds = useMemo(
    () => new Set(channelUsers.map((u) => u.id)),
    [channelUsers],
  )
  const boundAgentIds = useMemo(
    () => new Set(boundAgents.map((a) => a.id)),
    [boundAgents],
  )

  const lowerSearch = search.toLowerCase().trim()

  const filteredUsers = useMemo(
    () =>
      channelUsers.filter(
        (u) =>
          !lowerSearch ||
          u.displayName.toLowerCase().includes(lowerSearch) ||
          u.email.toLowerCase().includes(lowerSearch),
      ),
    [channelUsers, lowerSearch],
  )

  const filteredAgents = useMemo(
    () =>
      boundAgents.filter(
        (a) =>
          !lowerSearch ||
          a.name.toLowerCase().includes(lowerSearch) ||
          a.role.toLowerCase().includes(lowerSearch),
      ),
    [boundAgents, lowerSearch],
  )

  const availableUsers = useMemo(
    () =>
      allUsers.filter(
        (u) =>
          !channelUserIds.has(u.id) &&
          (!lowerSearch ||
            u.displayName.toLowerCase().includes(lowerSearch) ||
            u.email.toLowerCase().includes(lowerSearch)),
      ),
    [allUsers, channelUserIds, lowerSearch],
  )

  const availableAgents = useMemo(
    () =>
      allAgents.filter(
        (a) =>
          !boundAgentIds.has(a.id) &&
          (!lowerSearch ||
            a.name.toLowerCase().includes(lowerSearch) ||
            a.role.toLowerCase().includes(lowerSearch)),
      ),
    [allAgents, boundAgentIds, lowerSearch],
  )

  const totalMembers = channelUsers.length + boundAgents.length
  const hasAvailable = availableUsers.length > 0 || availableAgents.length > 0

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
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
        className={[
          'flex max-h-[80vh] w-full max-w-[480px] flex-col rounded-xl',
          'border border-[color:var(--sep)] bg-[color:var(--main)]',
        ].join(' ')}
        style={{ boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-white">
              #{channelLabel} members
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
              {totalMembers} member{totalMembers !== 1 ? 's' : ''}
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
              'flex items-center gap-2 rounded-lg border',
              'border-[color:var(--border-strong)] bg-white/5 px-3 py-2',
            ].join(' ')}
          >
            <svg
              className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
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
                'w-full bg-transparent text-sm text-[color:var(--tx)] outline-none',
                'placeholder:text-[color:var(--tx3)]',
              ].join(' ')}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members or agents..."
              value={search}
            />
          </div>
        </div>

        {/* Scrollable list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {/* Current members */}
          {(filteredUsers.length > 0 || filteredAgents.length > 0) && (
            <div>
              <div
                className={[
                  'px-3 py-1.5 text-[11px] font-semibold uppercase',
                  'tracking-[0.16em] text-[color:var(--tx3)]',
                ].join(' ')}
              >
                In this channel
              </div>

              {filteredUsers.map((user) => (
                <div key={user.id} className={rowClass}>
                  <div
                    className={[
                      'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
                      'text-xs font-semibold text-white',
                    ].join(' ')}
                    style={{ background: pickGradient(user.id) }}
                  >
                    {getInitials(user.displayName, '?')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">
                      {user.displayName}
                      {user.id === currentUserId && (
                        <span className="ml-1.5 text-xs text-[color:var(--tx3)]">
                          (you)
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-[color:var(--tx3)]">
                      {user.email}
                    </div>
                  </div>
                  <span
                    className={[
                      'rounded bg-white/6 px-1.5 py-0.5 text-[10px] uppercase',
                      'tracking-[0.12em] text-[color:var(--tx3)]',
                    ].join(' ')}
                  >
                    user
                  </span>
                  {user.id !== currentUserId && (
                    <button
                      className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-red-500/10 hover:text-red-400`}
                      disabled={removeMember.isPending}
                      onClick={() =>
                        removeMember.mutate({
                          channelId,
                          userId: user.id,
                        })
                      }
                      title="Remove from channel"
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
                  )}
                </div>
              ))}

              {filteredAgents.map((agent) => (
                <div key={agent.id} className={rowClass}>
                  <div
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm"
                    style={{ background: agentGradient }}
                  >
                    {getAgentGlyph(agent.role)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">
                      {agent.name}
                    </div>
                    <div className="truncate text-xs text-[color:var(--tx3)]">
                      {agent.role}
                    </div>
                  </div>
                  <span
                    className={[
                      'rounded border border-[rgba(124,58,237,0.3)]',
                      'bg-[rgba(124,58,237,0.15)] px-1.5 py-0.5',
                      'text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a78bfa]',
                    ].join(' ')}
                  >
                    agent
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      className={[
                        actionBtnClass,
                        'text-[color:var(--tx3)] hover:bg-[rgba(124,58,237,0.15)]',
                        'hover:text-[#a78bfa]',
                      ].join(' ')}
                      disabled={cloneAgent.isPending}
                      onClick={() => cloneAgent.mutate(agent.id)}
                      title="Clone to personal collection"
                      type="button"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <rect
                          height="13"
                          rx="2"
                          width="13"
                          x="9"
                          y="9"
                        />
                        <path
                          d={[
                            'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
                          ].join(' ')}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      className={[
                        actionBtnClass,
                        'text-[color:var(--tx3)] hover:bg-[rgba(124,58,237,0.15)]',
                        'hover:text-[#a78bfa]',
                      ].join(' ')}
                      onClick={() => {
                        onSelectAgent(agent.id)
                        onClose()
                      }}
                      title="View agent details"
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
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d={[
                            'M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943',
                            '9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943',
                            '-9.542-7z',
                          ].join(' ')}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      className={`${actionBtnClass} text-[color:var(--tx3)] hover:bg-red-500/10 hover:text-red-400`}
                      disabled={unbindAgent.isPending}
                      onClick={() =>
                        unbindAgent.mutate({
                          agentId: agent.id,
                          channelId,
                        })
                      }
                      title="Remove from channel"
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
                </div>
              ))}
            </div>
          )}

          {/* Available to add */}
          {hasAvailable && (
            <div className="mt-2">
              <div
                className={[
                  'px-3 py-1.5 text-[11px] font-semibold uppercase',
                  'tracking-[0.16em] text-[color:var(--tx3)]',
                ].join(' ')}
              >
                Add to channel
              </div>

              {availableUsers.map((user) => (
                <div key={user.id} className={rowClass}>
                  <div
                    className={[
                      'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
                      'text-xs font-semibold text-white/60',
                    ].join(' ')}
                    style={{
                      background: pickGradient(user.id),
                      opacity: 0.6,
                    }}
                  >
                    {getInitials(user.displayName, '?')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[color:var(--tx2)]">
                      {user.displayName}
                    </div>
                    <div className="truncate text-xs text-[color:var(--tx3)]">
                      {user.email}
                    </div>
                  </div>
                  <button
                    className={[
                      actionBtnClass,
                      'border border-[color:var(--border-strong)] text-[color:var(--tx2)]',
                      'hover:border-white/20 hover:text-white',
                    ].join(' ')}
                    disabled={addMember.isPending}
                    onClick={() =>
                      addMember.mutate(
                        { channelId, userId: user.id },
                        {
                          onSuccess: (data) => {
                            if (channelType === 'dm' && data?.id) {
                              onGroupCreated(data.id)
                            }
                          },
                        },
                      )
                    }
                    type="button"
                  >
                    Add
                  </button>
                </div>
              ))}

              {availableAgents.map((agent) => (
                <div key={agent.id} className={rowClass}>
                  <div
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm opacity-60"
                    style={{ background: agentGradient }}
                  >
                    {getAgentGlyph(agent.role)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[color:var(--tx2)]">
                      {agent.name}
                    </div>
                    <div className="truncate text-xs text-[color:var(--tx3)]">
                      {agent.role}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className={[
                        actionBtnClass,
                        'text-[color:var(--tx3)] hover:bg-[rgba(124,58,237,0.15)]',
                        'hover:text-[#a78bfa]',
                      ].join(' ')}
                      disabled={cloneAgent.isPending}
                      onClick={() => cloneAgent.mutate(agent.id)}
                      title="Clone to personal collection"
                      type="button"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <rect
                          height="13"
                          rx="2"
                          width="13"
                          x="9"
                          y="9"
                        />
                        <path
                          d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      className={[
                        actionBtnClass,
                        'border border-[rgba(124,58,237,0.3)] text-[#a78bfa]',
                        'hover:bg-[rgba(124,58,237,0.15)]',
                      ].join(' ')}
                      disabled={bindAgent.isPending}
                      onClick={() =>
                        bindAgent.mutate({
                          agentId: agent.id,
                          channelId,
                        })
                      }
                      type="button"
                    >
                      Add
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {filteredUsers.length === 0 &&
            filteredAgents.length === 0 &&
            !hasAvailable && (
              <div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">
                No members match your search.
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
