import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { MentionInput, type MentionInputHandle, type MentionEntity } from '../components/shared/MentionInput'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'

type OptimisticMessage = {
  clientId: string
  content: string
  createdAt: string
  status: 'sending' | 'failed'
}
import {
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import { useSendMessage } from '../facades/messages/hooks'
import { useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { useTools } from '../facades/tools/hooks'
import { useUsers } from '../facades/users/hooks'
import type { AgentRecord, ThreadMessageRecord } from '../lib/api-client'
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { ChannelMembersPopup } from '../components/shared/ChannelMembersPopup'

type ChannelTab = 'agents' | 'messages' | 'runs'

type FeedItem =
  | { kind: 'date'; label: string }
  | { kind: 'message'; message: ThreadMessageRecord }

const toolbarButtonClass =
  'flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-white/10'

const runsCardClass = [
  'admin-card flex items-start gap-3 p-3 text-left',
  'hover:bg-[color:var(--main-hover)]',
].join(' ')

const formatDayLabel = (value: string): string => {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()

  if (sameDay(date, today)) {
    return 'Today'
  }

  if (sameDay(date, yesterday)) {
    return 'Yesterday'
  }

  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const formatClock = (value: string): string =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

const memberGradients = [
  'linear-gradient(135deg,#7c3aed,#4f46e5)',
  'linear-gradient(135deg,#0891b2,#0369a1)',
  'linear-gradient(135deg,#047857,#065f46)',
  'linear-gradient(135deg,#b45309,#92400e)',
  'linear-gradient(135deg,#be185d,#9d174d)',
  'linear-gradient(135deg,#1d4ed8,#1e40af)',
  'linear-gradient(135deg,#dc2626,#b91c1c)',
  'linear-gradient(135deg,#0d9488,#0f766e)',
] as const

const agentGradient = 'linear-gradient(135deg,#7c3aed,#6d28d9)'

const pickGradient = (id: string): string => {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return memberGradients[Math.abs(hash) % memberGradients.length] ?? memberGradients[0]
}

const getInitials = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

const buildFeedItems = (messages: ThreadMessageRecord[]): FeedItem[] => {
  const items: FeedItem[] = []
  let previousDateLabel: string | null = null

  for (const message of messages) {
    const dateLabel = formatDayLabel(message.createdAt)
    if (dateLabel !== previousDateLabel) {
      items.push({ kind: 'date', label: dateLabel })
      previousDateLabel = dateLabel
    }
    items.push({ kind: 'message', message })
  }

  return items
}

const getAgentGlyph = (agent?: AgentRecord | null): string => {
  if (!agent) {
    return '⚡'
  }

  const role = agent.role.toLowerCase()
  if (role.includes('research')) {
    return '🔍'
  }
  if (role.includes('write')) {
    return '📝'
  }
  return '⚡'
}

const getDisplayName = (
  entry: ThreadMessageRecord,
  meDisplayName: string,
  agentMap: Map<string, AgentRecord>,
): string => {
  if (entry.role === 'assistant') {
    return agentMap.get(entry.agentId ?? '')?.name ?? 'Agent'
  }

  if (entry.role === 'system') {
    return 'System'
  }

  return meDisplayName
}

export const ChannelsPage = () => {
  const navigate = useNavigate()
  const { channelId } = useParams()
  const { me } = useAuthSession()
  const { onSelectAgent, scopedAgents } =
    useOutletContext<AdminShellOutletContext>()
  const { data: channels = [] } = useChannels()
  const { data: agents = [] } = useAgents()
  const { data: tools = [] } = useTools()
  const isOwner = me?.user.roleIds?.includes('owner') ?? false
  const { data: allUsers = [] } = useUsers(isOwner)

  const activeChannel =
    channels.find((channel) => channel.id === channelId) ?? channels[0] ?? null
  const boundAgents = useMemo(
    () =>
      activeChannel
        ? agents.filter((agent) => agent.channelIds.includes(activeChannel.id))
        : [],
    [activeChannel, agents],
  )
  const agentMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const { data: threadMessages = [] } = useThreadMessages(
    activeChannel?.defaultThreadId,
  )
  const { pendingMessages } = useThreadStream(activeChannel?.defaultThreadId)
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)

  const channelUsers = useMemo(
    () =>
      activeChannel
        ? allUsers.filter((user) => user.channelIds.includes(activeChannel.id))
        : [],
    [activeChannel, allUsers],
  )

  const [activeTab, setActiveTab] = useState<ChannelTab>('messages')
  const [message, setMessage] = useState('')
  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([])
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const mentionRef = useRef<MentionInputHandle>(null)

  // Clear optimistic bubble once the real message from the server arrives.
  // Match on content + proximity: any optimistic entry whose content equals
  // a persisted user message can be dropped.
  useEffect(() => {
    if (optimisticMessages.length === 0) return
    const persistedContents = new Set(
      threadMessages
        .filter((m) => m.role === 'user' && m.userId === me?.user.id)
        .map((m) => m.content),
    )
    if ([...optimisticMessages].some((o) => persistedContents.has(o.content))) {
      setOptimisticMessages((current) =>
        current.filter((o) => !persistedContents.has(o.content) || o.status === 'failed'),
      )
    }
  }, [threadMessages, optimisticMessages, me?.user.id])

  // Reset optimistic state when switching channels.
  useEffect(() => {
    setOptimisticMessages([])
  }, [activeChannel?.id])

  const mentionEntities: MentionEntity[] = useMemo(
    () => [
      ...agents.map((a) => ({
        id: a.id,
        name: a.name,
        type: 'agent' as const,
        glyph: getAgentGlyph(a),
      })),
      ...channelUsers.map((u) => ({
        id: u.id,
        name: u.displayName,
        type: 'user' as const,
      })),
    ],
    [agents, channelUsers],
  )

  const mentionEntityMap = useMemo(
    () => new Map(mentionEntities.map((entity) => [entity.name, entity])),
    [mentionEntities],
  )
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const sortedMentionNames = useMemo(
    () =>
      [...mentionEntityMap.keys()].sort(
        (left, right) => right.length - left.length,
      ),
    [mentionEntityMap],
  )

  const renderContent = useCallback(
    (text: string): ReactNode => {
      if (!mentionEntityMap.size) return text
      const parts: ReactNode[] = []
      let cursor = 0

      while (cursor < text.length) {
        const atIndex = text.indexOf('@', cursor)
        if (atIndex === -1) {
          parts.push(text.slice(cursor))
          break
        }

        const hasMentionBoundaryBefore =
          atIndex === 0 || /\s/.test(text[atIndex - 1] ?? '')

        if (!hasMentionBoundaryBefore) {
          parts.push(text.slice(cursor, atIndex + 1))
          cursor = atIndex + 1
          continue
        }

        const entityName = sortedMentionNames.find((candidate) => {
          if (!text.startsWith(candidate, atIndex + 1)) {
            return false
          }

          const boundaryChar = text[atIndex + 1 + candidate.length]
          return boundaryChar === undefined || /[\s.,!?;:()[\]{}]/.test(boundaryChar)
        })

        if (!entityName) {
          parts.push(text.slice(cursor, atIndex + 1))
          cursor = atIndex + 1
          continue
        }

        const entity = mentionEntityMap.get(entityName)
        if (entity) {
          if (atIndex > cursor) {
            parts.push(text.slice(cursor, atIndex))
          }
          parts.push(
            <button
              className="mention-tag mention-tag-link"
              key={`${entity.id}:${atIndex}`}
              onClick={() => {
                if (entity.type === 'agent') {
                  onSelectAgent(entity.id)
                  return
                }

                void navigate('/settings#users')
              }}
              title={
                entity.type === 'agent'
                  ? `Open ${entity.name}`
                  : `Open ${entity.name} in workspace users`
              }
              type="button"
            >
              @{entityName}
            </button>,
          )
          cursor = atIndex + 1 + entityName.length
          continue
        }

        parts.push(text.slice(cursor, atIndex + 1))
        cursor = atIndex + 1
      }

      if (parts.length === 0) return text
      return <>{parts}</>
    },
    [mentionEntityMap, navigate, onSelectAgent, sortedMentionNames],
  )

  useEffect(() => {
    if (!channelId && activeChannel) {
      void navigate(`/channels/${activeChannel.id}`, { replace: true })
    }
  }, [activeChannel, channelId, navigate])

  const feedItems = useMemo(() => buildFeedItems(threadMessages), [threadMessages])

  useLayoutEffect(() => {
    const container = contentScrollRef.current
    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  }, [
    activeChannel?.id,
    activeTab,
    feedItems.length,
    optimisticMessages.length,
    pendingMessages.length,
    scopedAgents.length,
  ])

  const sendText = useCallback(
    async (rawText: string) => {
      const text = rawText.trim()
      if (!activeChannel || !text) {
        return
      }

      if (text.length > CHAT_MESSAGE_MAX_CHARS) {
        // Typed-past-the-limit path: show the same dialog so the user can
        // trim or cancel instead of getting a server 413 after the round
        // trip.
        setOversizePaste(text)
        return
      }

      const clientId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
      const optimistic: OptimisticMessage = {
        clientId,
        content: text,
        createdAt: new Date().toISOString(),
        status: 'sending',
      }
      setOptimisticMessages((current) => [...current, optimistic])
      setMessage('')
      mentionRef.current?.clear()

      try {
        await sendMessage.mutateAsync({ content: text })
      } catch {
        setOptimisticMessages((current) =>
          current.map((entry) =>
            entry.clientId === clientId ? { ...entry, status: 'failed' } : entry,
          ),
        )
      }
    },
    [activeChannel, sendMessage],
  )

  const sendMessageSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    const text = mentionRef.current?.getText() ?? message
    // Clear synchronously before awaiting the network mutation so a
    // second submit (double-enter, double-click) can't re-read the
    // same contentEditable text.
    mentionRef.current?.clear()
    await sendText(text)
  }

  if (!me) {
    return null
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center border-b border-[color:var(--sep)] px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex-shrink-0 text-lg font-bold text-[color:var(--tx3)]">
            #
          </span>
          <h1 className="truncate text-[17px] font-bold text-white">
            {activeChannel?.label ?? 'channels'}
          </h1>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/5"
            onClick={() => setShowMembersPopup(true)}
            title="View channel members"
            type="button"
          >
            <div className="flex -space-x-1.5">
              {channelUsers.slice(0, 3).map((user) => (
                <div
                  key={user.id}
                  className={[
                    'flex h-6 w-6 items-center justify-center rounded-full border-2',
                    'border-[color:var(--main)] text-[8px] font-bold text-white',
                  ].join(' ')}
                  style={{ background: pickGradient(user.id) }}
                >
                  {getInitials(user.displayName)}
                </div>
              ))}
              {boundAgents.slice(0, Math.max(0, 4 - channelUsers.length)).map((agent) => (
                <div
                  key={agent.id}
                  className={[
                    'flex h-6 w-6 items-center justify-center rounded-full border-2',
                    'border-[color:var(--main)] text-[10px]',
                  ].join(' ')}
                  style={{ background: agentGradient }}
                >
                  {getAgentGlyph(agent)}
                </div>
              ))}
            </div>
            <span className="text-sm text-[color:var(--tx2)]">
              {channelUsers.length + boundAgents.length}
            </span>
          </button>
          <div className="mx-1 h-5 w-px bg-[color:var(--border-strong)]" />
          <button className={toolbarButtonClass} type="button">
            <svg
              className="h-4 w-4"
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
          </button>
          <button className={toolbarButtonClass} type="button">
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path
                d="M4 6h16M4 12h16M4 18h16"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex h-9 items-center border-b border-[color:var(--sep)] px-3">
        <button
          className={`admin-tab ${activeTab === 'messages' ? 'active' : ''}`}
          onClick={() => setActiveTab('messages')}
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path
              d={[
                'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8',
                'a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72',
                'C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
              ].join(' ')}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Messages
        </button>
        <button
          className={`admin-tab ${activeTab === 'runs' ? 'active' : ''}`}
          onClick={() => setActiveTab('runs')}
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 0a2 2 0 002 2h2a2 2 0 002-2m-6 9l2 2 4-4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Runs
        </button>
        <button
          className={`admin-tab ${activeTab === 'agents' ? 'active' : ''}`}
          onClick={() => setActiveTab('agents')}
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="8" r="4" />
            <path
              d="M4 20c0-4 3.582-7 8-7s8 3 8 7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Agents
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="channel-content-scroll"
        ref={contentScrollRef}
      >
        {activeTab === 'messages' ? (
          <>
            {feedItems.length === 0 &&
            pendingMessages.length === 0 &&
            optimisticMessages.length === 0 ? (
              <div className="p-5">
                <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
                  No messages yet. Send the first message to start this thread.
                </div>
              </div>
            ) : null}

            {feedItems.map((item, index) =>
              item.kind === 'date' ? (
                <div key={`${item.label}:${index}`} className="admin-date-sep">
                  <span className="admin-date-pill">
                    {item.label}
                    <svg
                      className="h-3 w-3 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M19 9l-7 7-7-7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </div>
              ) : (
                <article key={item.message.id} className="admin-msg-row py-1">
                  {item.message.role === 'assistant' ? (
                    <div
                      className={[
                        'flex h-9 w-9 flex-shrink-0 items-center justify-center',
                        'rounded-lg border border-[rgba(124,58,237,0.4)]',
                        'bg-[rgba(124,58,237,0.1)] text-lg',
                      ].join(' ')}
                    >
                      {getAgentGlyph(agentMap.get(item.message.agentId ?? ''))}
                    </div>
                  ) : (
                    <div
                      className="h-9 w-9 flex-shrink-0 rounded-md"
                      style={{ background: memberGradients[0] }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-white">
                        {getDisplayName(item.message, me.user.displayName, agentMap)}
                      </span>
                      {item.message.role === 'assistant' ? (
                        <span
                          className={[
                            'inline-flex items-center gap-1 rounded',
                            'border border-[rgba(124,58,237,0.3)]',
                            'bg-[rgba(124,58,237,0.15)] px-1.5 py-0.5',
                            'text-[11px] font-semibold text-[#a78bfa]',
                          ].join(' ')}
                        >
                          agent
                        </span>
                      ) : null}
                      <span className="text-xs text-[color:var(--tx3)]">
                        {formatClock(item.message.createdAt)}
                      </span>
                    </div>
                    <div
                      className={
                        item.message.role === 'assistant'
                          ? 'mt-0.5 border-l-2 border-[rgba(124,58,237,0.5)] pl-3'
                          : 'mt-0.5'
                      }
                    >
                      <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                        {renderContent(item.message.content)}
                      </p>
                      {item.message.reactions?.length ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {Object.entries(
                            item.message.reactions.reduce<Record<string, number>>((acc, r) => {
                              acc[r.emoji] = (acc[r.emoji] ?? 0) + 1
                              return acc
                            }, {}),
                          ).map(([emoji, count]) => (
                            <span key={emoji} className="reaction-pill">
                              {emoji}{count > 1 ? ` ${count}` : ''}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              ),
            )}

            {optimisticMessages.map((entry) => (
              <article
                key={entry.clientId}
                className="admin-msg-row py-1"
                data-testid="optimistic-message"
              >
                <div
                  className="h-9 w-9 flex-shrink-0 rounded-md"
                  style={{ background: memberGradients[0] }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold text-white">
                      {me.user.displayName}
                    </span>
                    {entry.status === 'failed' ? (
                      <span
                        className={[
                          'inline-flex items-center rounded px-1.5 py-0.5',
                          'bg-[rgba(239,68,68,0.18)] text-[11px] font-semibold text-[#fca5a5]',
                        ].join(' ')}
                      >
                        failed
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-[color:var(--tx3)]"
                        title="Sending…"
                      >
                        sending
                        <span className="streaming-dot" />
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5">
                    <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                      {renderContent(entry.content)}
                    </p>
                  </div>
                </div>
              </article>
            ))}

            {pendingMessages.length > 0 ? (
              <div className="admin-date-sep">
                <span className="admin-date-pill">
                  Live
                  <svg
                    className="h-3 w-3 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M19 9l-7 7-7-7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </div>
            ) : null}

            {pendingMessages.map((entry) => {
              const pendingAgent = agentById.get(entry.agentId) ?? null

              return (
                <article key={entry.runId} className="admin-msg-row py-1">
                  <div
                    className={[
                      'flex h-9 w-9 flex-shrink-0 items-center justify-center',
                      'rounded-lg border border-[rgba(124,58,237,0.4)]',
                      'bg-[rgba(124,58,237,0.1)] text-lg',
                    ].join(' ')}
                  >
                    {getAgentGlyph(pendingAgent)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-white">
                        {pendingAgent?.name ?? 'Agent'}
                      </span>
                      <span
                        className={[
                          'inline-flex items-center rounded',
                          'bg-[rgba(124,58,237,0.2)] px-2 py-0.5',
                          'text-[11px] font-semibold text-[#a78bfa]',
                        ].join(' ')}
                      >
                        running
                      </span>
                    </div>
                    <div className="mt-0.5 border-l-2 border-[rgba(124,58,237,0.5)] pl-3">
                      <p className="text-sm leading-6 text-[color:var(--tx)]">
                        {entry.content ? renderContent(entry.content) : 'Streaming response'}
                        <span className="streaming-dot" />
                      </p>
                    </div>
                  </div>
                </article>
              )
            })}
            <div className="h-3" />
          </>
        ) : null}

        {activeTab === 'runs' ? (
          <div className="grid gap-4 p-5 lg:grid-cols-2">
            <section className="admin-card p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                Active runs
              </div>
              <div className="mt-4 grid gap-3">
                {scopedAgents.length > 0 ? (
                  scopedAgents.map((agent) => (
                    <button
                      key={agent.id}
                      className={runsCardClass}
                      onClick={() => onSelectAgent(agent.id)}
                      type="button"
                    >
                      <div
                        className={[
                          'mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center',
                          'rounded-md bg-[rgba(124,58,237,0.14)]',
                        ].join(' ')}
                      >
                        {getAgentGlyph(agent)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold text-white">
                            {agent.name}
                          </span>
                          <span
                            className={[
                              'rounded bg-white/6 px-1.5 py-0.5 text-[10px]',
                              'uppercase tracking-[0.16em] text-[color:var(--tx3)]',
                            ].join(' ')}
                          >
                            {agent.status}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-[color:var(--tx2)]">
                          {agent.currentToolName ?? 'Idle'}
                        </div>
                        <div className="mt-2 text-xs text-[color:var(--tx3)]">
                          Last activity {formatClock(agent.lastActivityAt)}
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="text-sm text-[color:var(--tx3)]">
                    No agent runs in this channel yet.
                  </div>
                )}
              </div>
            </section>

            <section className="admin-card p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                Workspace signals
              </div>
              <div className="mt-4 grid gap-3 text-sm">
                <div className="admin-card p-3">
                  <div className="text-[color:var(--tx3)]">Safe tools</div>
                  <div className="mt-1 text-2xl font-semibold text-white">
                    {tools.length}
                  </div>
                </div>
                <div className="admin-card p-3">
                  <div className="text-[color:var(--tx3)]">Streaming messages</div>
                  <div className="mt-1 text-2xl font-semibold text-white">
                    {pendingMessages.length}
                  </div>
                </div>
                <div className="admin-card p-3">
                  <div className="text-[color:var(--tx3)]">Bound agents</div>
                  <div className="mt-1 text-2xl font-semibold text-white">
                    {boundAgents.length}
                  </div>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {activeTab === 'agents' ? (
          <div className="grid gap-4 p-5 lg:grid-cols-2">
            {boundAgents.length > 0 ? (
              boundAgents.map((agent) => (
                <article key={agent.id} className="admin-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={[
                          'flex h-9 w-9 items-center justify-center rounded-lg',
                          'bg-[rgba(124,58,237,0.14)] text-lg',
                        ].join(' ')}
                      >
                        {getAgentGlyph(agent)}
                      </div>
                      <div>
                        <div className="font-semibold text-white">{agent.name}</div>
                        <div className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                          {agent.role}
                        </div>
                      </div>
                    </div>
                    <button
                      className="admin-button admin-button-secondary"
                      onClick={() => onSelectAgent(agent.id)}
                      type="button"
                    >
                      Open activity
                    </button>
                  </div>
                  <div className="mt-4 text-sm leading-6 text-[color:var(--tx2)]">
                    {agent.systemPrompt ?? 'No system prompt configured for this agent yet.'}
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs text-[color:var(--tx3)]">
                    <span>Status: {agent.status}</span>
                    <span>{agent.channelIds.length} channel bindings</span>
                  </div>
                </article>
              ))
            ) : (
              <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
                No agents are bound to this channel yet. Use the admin page to create or
                bind one.
              </div>
            )}

            <div className="admin-card p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                Manage agents
              </div>
              <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
                Create new agents, bind them to channels, and inspect tool access from the
                admin route.
              </p>
              <button
                className="admin-button admin-button-primary mt-4"
                onClick={() => void navigate('/agents/new')}
                type="button"
              >
                Create agent
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex-shrink-0 px-5 pb-[14px]">
        <form className="admin-compose" onSubmit={sendMessageSubmit}>
          <MentionInput
            ref={mentionRef}
            entities={mentionEntities}
            maxLength={CHAT_MESSAGE_MAX_CHARS}
            onChange={setMessage}
            onOversizePaste={(paste) => setOversizePaste(paste)}
            onSubmit={(text) => void sendText(text)}
            placeholder={`Message #${activeChannel?.label ?? 'channel'} or @mention an agent`}
          />
          <div className="flex items-center justify-between border-t border-[color:var(--border-strong)] px-3 py-1.5">
            <div className="flex items-center gap-1">
              <button
                className={toolbarButtonClass}
                onClick={() => mentionRef.current?.insertAtSign()}
                type="button"
              >
                @
              </button>
              <button className={toolbarButtonClass} type="button">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button className={toolbarButtonClass} type="button">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path
                    d={[
                      'M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586',
                      'a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13',
                    ].join(' ')}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            <button
              className="flex h-[30px] items-center justify-center rounded-lg bg-[color:var(--accent)] px-3 text-white"
              disabled={!message.trim() || sendMessage.isPending}
              type="submit"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path
                  d="m12 19 9 2-9-18-9 18 9-2Zm0 0v-8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </form>
      </div>

      {showMembersPopup && activeChannel ? (
        <ChannelMembersPopup
          allAgents={agents}
          allUsers={allUsers}
          boundAgents={boundAgents}
          channelId={activeChannel.id}
          channelLabel={activeChannel.label}
          channelUsers={channelUsers}
          currentUserId={me.user.id}
          onClose={() => setShowMembersPopup(false)}
          onSelectAgent={onSelectAgent}
        />
      ) : null}

      <OversizePasteDialog
        limit={CHAT_MESSAGE_MAX_CHARS}
        onCancel={() => setOversizePaste(null)}
        onInsertTrimmed={(trimmed) => {
          setOversizePaste(null)
          mentionRef.current?.insertText(trimmed)
        }}
        open={oversizePaste !== null}
        pastedText={oversizePaste ?? ''}
      />
    </section>
  )
}
