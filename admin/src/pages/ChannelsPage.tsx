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
import {
  useNavigate,
  useOutletContext,
  useParams,
} from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useChannels } from '../facades/channels/hooks'
import {
  useDeleteMessage,
  useMessageSearch,
  useSendMessage,
  useUpdateMessage,
} from '../facades/messages/hooks'
import {
  isPersonalAssistantChannel,
  usePersonalAssistant,
} from '../facades/personal-assistant/hooks'
import { useMarkThreadRead, useThreadMessages, useThreadStream } from '../facades/threads/hooks'
import { useTools } from '../facades/tools/hooks'
import { useUsers } from '../facades/users/hooks'
import type { AdminShellOutletContext } from '../layouts/AdminShellLayout'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { CallBanner } from '../components/shared/CallBanner'
import { CallOverlay } from '../components/shared/CallOverlay'
import { ChannelMembersPopup } from '../components/shared/ChannelMembersPopup'
import { AgentInfoCard } from '../components/features/agents/AgentInfoCard'
import { PersonalAssistantConfigBanner } from '../components/features/personal-assistant/PersonalAssistantSurface'
import { useActiveCall, useJoinCall, useLeaveCall, useStartCall } from '../facades/calls/hooks'
import { agentGradient, getInitials, memberGradients, pickGradient } from '../lib/avatar'
import {
  buildFeedItems,
  formatClock,
  getAgentGlyph,
  getDisplayName,
  isOperationsTab,
  runsCardClass,
  toolbarButtonClass,
  type ChannelTab,
  type OptimisticMessage,
} from '../components/features/channels/channel-helpers'

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
  const isPersonalAssistantActiveChannel = isPersonalAssistantChannel(activeChannel)
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
  const { data: personalAssistantState } = usePersonalAssistant(
    isPersonalAssistantActiveChannel,
  )
  const markThreadRead = useMarkThreadRead()
  const { pendingMessages } = useThreadStream(activeChannel?.defaultThreadId)
  const sendMessage = useSendMessage(activeChannel?.defaultThreadId)
  const updateMessage = useUpdateMessage(activeChannel?.defaultThreadId)
  const deleteMessage = useDeleteMessage(activeChannel?.defaultThreadId)

  // sp-messaging slice: inline edit + channel search state.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const { data: searchResults = [] } = useMessageSearch(activeChannel?.id, searchQuery)

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
  const [showCallOverlay, setShowCallOverlay] = useState(false)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const mentionRef = useRef<MentionInputHandle>(null)

  const { data: activeCall } = useActiveCall(activeChannel?.id)
  const startCall = useStartCall()
  const joinCall = useJoinCall()
  const leaveCall = useLeaveCall()
  const isPersonalAssistantConversation = isPersonalAssistantActiveChannel
  const isConversationSurface =
    activeChannel?.type === 'dm' || isPersonalAssistantConversation
  const visibleActiveTab =
    isConversationSurface && isOperationsTab(activeTab) ? 'messages' : activeTab
  const personalAssistantAgent =
    personalAssistantState?.agent ?? boundAgents[0] ?? null
  const personalAssistantChannel =
    personalAssistantState?.channel ?? activeChannel
  const callEligible =
    !isPersonalAssistantConversation && channelUsers.length >= 2
  const composePlaceholder = isPersonalAssistantConversation
    ? 'Message Personal Assistant'
    : activeChannel?.type === 'dm'
      ? `Message ${activeChannel.label}`
      : `Message #${activeChannel?.label ?? 'channel'} or @mention an agent`
  const activeParticipants = useMemo(
    () => (activeCall?.participants ?? []).filter((p) => !p.leftAt),
    [activeCall],
  )
  const isInCall = useMemo(
    () => activeParticipants.some((p) => p.userId === me?.user.id),
    [activeParticipants, me],
  )

  // Auto-open the overlay when the user joins or starts a call on the current channel.
  // Track channelId alongside isInCall so that navigating to a channel where the user
  // is already a participant does not spuriously trigger the overlay.
  const prevCallStateRef = useRef<{ channelId: string | undefined; isInCall: boolean }>({
    channelId: activeChannel?.id,
    isInCall: false,
  })
  useEffect(() => {
    const prev = prevCallStateRef.current
    const channelChanged = prev.channelId !== activeChannel?.id
    if (!channelChanged && isInCall && !prev.isInCall) {
      setShowCallOverlay(true)
    }
    prevCallStateRef.current = { channelId: activeChannel?.id, isInCall }
  }, [isInCall, activeChannel?.id])

  useEffect(() => {
    if (isConversationSurface && isOperationsTab(activeTab)) {
      setActiveTab('messages')
    }
  }, [activeTab, isConversationSurface])

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

  // Reset optimistic state and call overlay when switching channels.
  useEffect(() => {
    setOptimisticMessages([])
    setShowCallOverlay(false)
    setEditingMessageId(null)
    setEditingContent('')
    setSearchOpen(false)
    setSearchQuery('')
  }, [activeChannel?.id])

  const submitEdit = useCallback(
    async (messageId: string) => {
      const next = editingContent.trim()
      if (!next) {
        return
      }
      try {
        await updateMessage.mutateAsync({ content: next, messageId })
      } finally {
        setEditingMessageId(null)
        setEditingContent('')
      }
    },
    [editingContent, updateMessage],
  )

  const confirmDelete = useCallback(
    (messageId: string) => {
      if (!window.confirm('Delete this message? This cannot be undone.')) {
        return
      }
      deleteMessage.mutate(messageId)
    },
    [deleteMessage],
  )

  const jumpToMessage = useCallback((messageId: string) => {
    const element = document.getElementById(`msg-${messageId}`)
    if (!element) {
      return
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.classList.add('admin-msg-highlight')
    window.setTimeout(() => element.classList.remove('admin-msg-highlight'), 1600)
  }, [])

  const lastReadMarkerRef = useRef<string | null>(null)
  const pendingReadMarkerRef = useRef<string | null>(null)
  useEffect(() => {
    lastReadMarkerRef.current = null
    pendingReadMarkerRef.current = null
  }, [activeChannel?.defaultThreadId])

  useEffect(() => {
    const threadId = activeChannel?.defaultThreadId
    const latestMessageId = threadMessages.at(-1)?.id
    if (!threadId || !latestMessageId) {
      return
    }

    const marker = `${threadId}:${latestMessageId}`
    if (lastReadMarkerRef.current === marker || pendingReadMarkerRef.current === marker) {
      return
    }

    pendingReadMarkerRef.current = marker
    markThreadRead.mutate(threadId, {
      onError: () => {
        pendingReadMarkerRef.current = null
      },
      onSuccess: () => {
        lastReadMarkerRef.current = marker
        pendingReadMarkerRef.current = null
      },
    })
  }, [activeChannel?.defaultThreadId, markThreadRead, threadMessages])

  const mentionEntities: MentionEntity[] = useMemo(
    () => [
      ...(isConversationSurface
        ? []
        : agents.map((a) => ({
            id: a.id,
            name: a.name,
            type: 'agent' as const,
            glyph: getAgentGlyph(a),
          }))),
      ...channelUsers.map((u) => ({
        id: u.id,
        name: u.displayName,
        type: 'user' as const,
      })),
    ],
    [agents, channelUsers, isConversationSurface],
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
    visibleActiveTab,
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
          {isPersonalAssistantConversation ? (
            <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(124,58,237,0.18)] text-[9px] font-bold text-white">
              ⚡
            </div>
          ) : activeChannel?.type === 'dm' ? (
            <div
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
              style={{ background: 'linear-gradient(135deg,#6d28d9,#4f46e5)' }}
            >
              {activeChannel.label.slice(0, 1).toUpperCase()}
            </div>
          ) : (
            <span className="flex-shrink-0 text-lg font-bold text-[color:var(--tx3)]">
              #
            </span>
          )}
          <h1 className="truncate text-[17px] font-bold text-white">
            {isPersonalAssistantConversation
              ? 'Personal Assistant'
              : activeChannel?.label ?? 'channels'}
          </h1>
          {isPersonalAssistantConversation && (
            <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              system managed
            </span>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            className={[
              'flex items-center gap-2 rounded-lg px-2 py-1',
              isPersonalAssistantConversation ? 'cursor-default opacity-90' : 'hover:bg-white/5',
            ].join(' ')}
            onClick={() => {
              if (!isPersonalAssistantConversation) {
                setShowMembersPopup(true)
              }
            }}
            title={
              isPersonalAssistantConversation
                ? 'Personal Assistant is system-managed'
                : 'View channel members'
            }
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
                  {getInitials(user.displayName, '?')}
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
          <button
            className={[
              'relative flex h-7 w-7 items-center justify-center rounded',
              callEligible
                ? isInCall
                  ? 'text-emerald-400 hover:bg-white/10'
                  : 'text-[color:var(--tx3)] hover:bg-white/10'
              : 'cursor-not-allowed text-[color:var(--tx3)] opacity-40',
            ].join(' ')}
            disabled={!callEligible}
            onClick={() => {
              if (!callEligible || !activeChannel) return
              if (!activeCall) {
                startCall.mutate(activeChannel.id)
              } else if (!isInCall) {
                joinCall.mutate(activeCall.id)
              } else {
                setShowCallOverlay((v) => !v)
              }
            }}
            title={
              isPersonalAssistantConversation
                ? 'Personal Assistant does not support calls'
                : callEligible
                ? activeCall
                  ? isInCall
                    ? 'Toggle call overlay'
                    : 'Join call'
                  : 'Start a call'
                : 'You can only start a call with humans for now'
            }
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
                d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {activeCall && !isInCall && (
              <span className="absolute right-0.5 top-0.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
            )}
          </button>
          <div className="mx-1 h-5 w-px bg-[color:var(--border-strong)]" />
          <button
            className={[
              toolbarButtonClass,
              searchOpen ? 'text-white' : '',
            ].join(' ')}
            onClick={() => {
              setSearchOpen((open) => {
                if (open) {
                  setSearchQuery('')
                }
                return !open
              })
            }}
            title="Search messages"
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

      {searchOpen ? (
        <div className="border-b border-[color:var(--sep)] px-5 py-2">
          <input
            autoFocus
            className="admin-input w-full text-sm"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false)
                setSearchQuery('')
              }
            }}
            placeholder="Search messages in this channel"
            type="text"
            value={searchQuery}
          />
          {searchQuery.trim().length > 0 ? (
            <div className="mt-2 max-h-64 overflow-y-auto">
              {searchResults.length === 0 ? (
                <div className="px-1 py-2 text-sm text-[color:var(--tx3)]">
                  No matches.
                </div>
              ) : (
                searchResults.map((result) => (
                  <button
                    key={result.id}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-white/5"
                    onClick={() => {
                      jumpToMessage(result.id)
                      setSearchOpen(false)
                      setSearchQuery('')
                    }}
                    type="button"
                  >
                    <span className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
                      <span className="font-semibold text-[color:var(--tx2)]">
                        {result.authorName}
                      </span>
                      #{result.channelLabel} · {formatClock(result.createdAt)}
                    </span>
                    <span className="truncate text-sm text-[color:var(--tx)]">
                      {result.snippet}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {activeCall && !isInCall && callEligible && activeParticipants.length > 0 && (
        <CallBanner
          participants={activeParticipants}
          onJoin={() => {
            joinCall.mutate(activeCall.id)
          }}
        />
      )}

      <div className="flex h-9 items-center border-b border-[color:var(--sep)] px-3">
        <button
          className={`admin-tab ${visibleActiveTab === 'messages' ? 'active' : ''}`}
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
          className={`admin-tab ${visibleActiveTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
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
              d="M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Files
        </button>
        <button
          className={`admin-tab ${visibleActiveTab === 'info' ? 'active' : ''}`}
          onClick={() => setActiveTab('info')}
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 11v5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="8" fill="currentColor" r="0.5" stroke="none" />
          </svg>
          Info
        </button>
        {!isConversationSurface ? (
          <button
            className={`admin-tab ${visibleActiveTab === 'runs' ? 'active' : ''}`}
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
        ) : null}
        {!isConversationSurface ? (
          <button
            className={`admin-tab ${visibleActiveTab === 'agents' ? 'active' : ''}`}
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
        ) : null}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="channel-content-scroll"
        ref={contentScrollRef}
      >
        {visibleActiveTab === 'messages' ? (
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
                <article
                  key={item.message.id}
                  id={`msg-${item.message.id}`}
                  className="admin-msg-row group relative py-1"
                >
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
                        {getDisplayName(
                          item.message,
                          me.user.displayName,
                          agentMap,
                          isPersonalAssistantConversation ? 'Personal Assistant' : 'Agent',
                        )}
                      </span>
                      {item.message.role === 'assistant' && !isPersonalAssistantConversation ? (
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
                      {item.message.editedAt && !item.message.deletedAt ? (
                        <span className="text-xs italic text-[color:var(--tx3)]">
                          (edited)
                        </span>
                      ) : null}
                    </div>
                    <div
                      className={
                        item.message.role === 'assistant'
                          ? 'mt-0.5 border-l-2 border-[rgba(124,58,237,0.5)] pl-3'
                          : 'mt-0.5'
                      }
                    >
                      {item.message.deletedAt ? (
                        <p className="text-sm italic leading-6 text-[color:var(--tx3)]">
                          This message was deleted
                        </p>
                      ) : editingMessageId === item.message.id ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            autoFocus
                            className="admin-input w-full resize-y text-sm"
                            onChange={(event) => setEditingContent(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                void submitEdit(item.message.id)
                              }
                              if (event.key === 'Escape') {
                                setEditingMessageId(null)
                                setEditingContent('')
                              }
                            }}
                            rows={2}
                            value={editingContent}
                          />
                          <div className="flex items-center gap-2">
                            <button
                              className="admin-button admin-button-primary"
                              disabled={updateMessage.isPending}
                              onClick={() => void submitEdit(item.message.id)}
                              type="button"
                            >
                              Save
                            </button>
                            <button
                              className="admin-button admin-button-secondary"
                              onClick={() => {
                                setEditingMessageId(null)
                                setEditingContent('')
                              }}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
                          {renderContent(item.message.content)}
                        </p>
                      )}
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
                  {item.message.role === 'user' &&
                  item.message.userId === me.user.id &&
                  !item.message.deletedAt &&
                  editingMessageId !== item.message.id ? (
                    <div className="absolute right-3 top-1 hidden items-center gap-1 group-hover:flex">
                      <button
                        className={toolbarButtonClass}
                        onClick={() => {
                          setEditingMessageId(item.message.id)
                          setEditingContent(item.message.content)
                        }}
                        title="Edit message"
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className={toolbarButtonClass}
                        onClick={() => confirmDelete(item.message.id)}
                        title="Delete message"
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
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
              const pendingDisplayName = isPersonalAssistantConversation
                ? 'Personal Assistant'
                : pendingAgent?.name ?? 'Agent'

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
                        {pendingDisplayName}
                      </span>
                      <span
                        className={[
                          'inline-flex items-center rounded',
                          'bg-[rgba(124,58,237,0.2)] px-2 py-0.5',
                          'text-[11px] font-semibold text-[#a78bfa]',
                        ].join(' ')}
                      >
                        {isPersonalAssistantConversation ? 'responding' : 'running'}
                      </span>
                    </div>
                    <div className="mt-0.5 border-l-2 border-[rgba(124,58,237,0.5)] pl-3">
                      <p className="whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx)]">
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

        {visibleActiveTab === 'files' ? (
          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="admin-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                    Conversation files
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
                    Files shared in this {isConversationSurface ? 'conversation' : 'channel'} will
                    live here instead of getting mixed into runs or agent controls.
                  </p>
                </div>
                <span className="rounded-full border border-[color:var(--sep)] bg-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--tx3)]">
                  Upload backend next
                </span>
              </div>

              <div className="mt-5 rounded-xl border border-dashed border-[color:var(--sep)] bg-black/10 p-8 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-white/6 text-[color:var(--tx2)]">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M15.172 7 8.586 13.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20.5 13"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="mt-4 text-sm font-semibold text-white">No files yet</div>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[color:var(--tx3)]">
                  Attachment upload is the next backend step. Once it lands, files attached to
                  messages and added directly to this surface will be searchable and manageable
                  from this tab.
                </p>
              </div>
            </section>

            <aside className="admin-card p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
                Scope
              </div>
              <div className="mt-4 grid gap-3 text-sm">
                <div className="rounded-lg border border-[color:var(--sep)] bg-black/10 p-3">
                  <div className="text-[color:var(--tx3)]">Surface</div>
                  <div className="mt-1 font-semibold text-white">
                    {isConversationSurface ? 'Conversation' : 'Channel'}
                  </div>
                </div>
                <div className="rounded-lg border border-[color:var(--sep)] bg-black/10 p-3">
                  <div className="text-[color:var(--tx3)]">Owner</div>
                  <div className="mt-1 font-semibold text-white">
                    {isPersonalAssistantConversation
                      ? 'Personal Assistant DM'
                      : activeChannel?.label ?? 'Current channel'}
                  </div>
                </div>
                <div className="rounded-lg border border-[color:var(--sep)] bg-black/10 p-3 text-[color:var(--tx2)]">
                  This tab is intentionally visible on every channel so file management has one
                  predictable home.
                </div>
              </div>
            </aside>
          </div>
        ) : null}

        {visibleActiveTab === 'info' ? (
          <div className="p-5">
            {isPersonalAssistantConversation ? (
              <PersonalAssistantConfigBanner
                agent={personalAssistantAgent}
                channel={personalAssistantChannel}
                configSummary={personalAssistantState?.configSummary}
              />
            ) : boundAgents.length > 0 ? (
              <div className="grid gap-3">
                {boundAgents.map((agent) => (
                  <AgentInfoCard agent={agent} key={agent.id} />
                ))}
              </div>
            ) : (
              <div className="admin-card p-4 text-sm text-[color:var(--tx3)]">
                No agents are bound to this channel.
              </div>
            )}
          </div>
        ) : null}

        {visibleActiveTab === 'runs' ? (
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

        {visibleActiveTab === 'agents' ? (
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
                onClick={() => void navigate('/agents/designer')}
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
            placeholder={composePlaceholder}
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
          channelType={activeChannel.type}
          channelUsers={channelUsers}
          currentUserId={me.user.id}
          onClose={() => setShowMembersPopup(false)}
          onGroupCreated={(newChannelId) => {
            setShowMembersPopup(false)
            navigate(`/channels/${newChannelId}`)
          }}
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

      {showCallOverlay && activeCall && isInCall && (
        <CallOverlay
          displayName={me?.user.displayName ?? 'User'}
          onLeave={() => {
            leaveCall.mutate(activeCall.id)
            setShowCallOverlay(false)
          }}
          roomId={activeCall.roomId}
        />
      )}
    </section>
  )
}
