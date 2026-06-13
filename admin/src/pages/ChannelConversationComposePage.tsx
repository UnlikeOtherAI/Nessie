import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { useAgents } from '../facades/agents/hooks'
import { useStartChannelConversation } from '../facades/channels/hooks'
import { useSendMessageToThread } from '../facades/messages/hooks'
import { useUsers } from '../facades/users/hooks'
import type { AgentRecord, UserRecord } from '../lib/api-client'
import { agentGradient } from '../lib/avatar'
import { MobileMenuButton } from '../layouts/admin-shell/MobileMenuButton'
import { UserAvatar } from '../components/primitives/UserAvatar'
import { MentionInput, type MentionEntity, type MentionInputHandle } from '../components/shared/MentionInput'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useAuthSession } from '../providers/AuthSessionProvider'

type RecipientKind = 'agent' | 'user'

type Recipient = {
  id: string
  kind: RecipientKind
}

type RecipientOption = Recipient & {
  detail: string
  label: string
  user?: UserRecord
}

const optionKey = (option: Recipient): string => `${option.kind}:${option.id}`

const matchesQuery = (option: RecipientOption, query: string): boolean => {
  const term = query.trim().toLowerCase()
  if (!term) {
    return true
  }
  return `${option.label} ${option.detail}`.toLowerCase().includes(term)
}

const getRecipientName = (
  recipient: Recipient,
  usersById: Map<string, UserRecord>,
  agentsById: Map<string, AgentRecord>,
): string => {
  if (recipient.kind === 'user') {
    return usersById.get(recipient.id)?.displayName ?? 'Unknown user'
  }
  return agentsById.get(recipient.id)?.name ?? 'Unknown agent'
}

export const ChannelConversationComposePage = () => {
  const navigate = useNavigate()
  const { me, token } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: allUsers = [] } = useUsers(isOwner)
  const { data: allAgents = [] } = useAgents()
  const startConversation = useStartChannelConversation()
  const sendMessage = useSendMessageToThread()
  const mentionRef = useRef<MentionInputHandle>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [query, setQuery] = useState('')
  const [addressFocused, setAddressFocused] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)

  const users = useMemo<UserRecord[]>(() => {
    if (!me) {
      return allUsers
    }
    const currentUser = allUsers.find((user) => user.id === me.user.id)
    if (currentUser) {
      return allUsers
    }
    return [
      {
        activeStatus: null,
        avatarAttachmentId: me.user.avatarAttachmentId ?? null,
        avatarUrl: me.user.avatarUrl ?? null,
        channelIds: [],
        createdAt: '',
        displayName: me.user.displayName,
        email: me.user.email,
        gravatarUrl: me.user.gravatarUrl ?? null,
        id: me.user.id,
        role: me.user.roleIds[0] ?? 'member',
        updatedAt: '',
      },
      ...allUsers,
    ]
  }, [allUsers, me])

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  )
  const agents = useMemo(
    () => (isOwner ? allAgents : []),
    [allAgents, isOwner],
  )
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const selectedKeys = useMemo(
    () => new Set(recipients.map(optionKey)),
    [recipients],
  )
  const options = useMemo<RecipientOption[]>(() => {
    const userOptions = users.map((user) => ({
      detail: user.email,
      id: user.id,
      kind: 'user' as const,
      label: user.id === me?.user.id ? `${user.displayName} (you)` : user.displayName,
      user,
    }))
    const agentOptions = agents.map((agent) => ({
      detail: agent.role,
      id: agent.id,
      kind: 'agent' as const,
      label: agent.name,
    }))

    return [...userOptions, ...agentOptions]
      .filter((option) => !selectedKeys.has(optionKey(option)))
      .filter((option) => matchesQuery(option, query))
      .slice(0, 8)
  }, [agents, me?.user.id, query, selectedKeys, users])

  const mentionEntities = useMemo<MentionEntity[]>(
    () =>
      recipients.map((recipient) => ({
        detail: recipient.kind === 'user' ? 'person' : 'agent',
        id: recipient.id,
        name: getRecipientName(recipient, usersById, agentsById),
        trigger: '@',
        type: recipient.kind,
      })),
    [agentsById, recipients, usersById],
  )

  const addRecipient = useCallback((option: RecipientOption) => {
    setRecipients((current) => [...current, { id: option.id, kind: option.kind }])
    setQuery('')
    setHighlightedIndex(0)
    window.setTimeout(() => addressInputRef.current?.focus(), 0)
  }, [])

  const removeRecipient = useCallback((recipient: Recipient) => {
    setRecipients((current) =>
      current.filter((item) => optionKey(item) !== optionKey(recipient)),
    )
  }, [])

  const submit = useCallback(
    async (rawText: string) => {
      const content = rawText.trim()
      if (!content) {
        return
      }
      if (recipients.length === 0) {
        setError('Choose at least one recipient.')
        addressInputRef.current?.focus()
        return
      }

      setError(null)
      try {
        const channel = await startConversation.mutateAsync({
          agentIds: recipients
            .filter((recipient) => recipient.kind === 'agent')
            .map((recipient) => recipient.id),
          userIds: recipients
            .filter((recipient) => recipient.kind === 'user')
            .map((recipient) => recipient.id),
        })
        await sendMessage.mutateAsync({
          content,
          threadId: channel.defaultThreadId,
        })
        mentionRef.current?.clear()
        setMessage('')
        void navigate(`/channels/${channel.id}`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start chat.')
      }
    },
    [navigate, recipients, sendMessage, startConversation],
  )

  const hasSelectableOptions =
    options.length > 0 && (recipients.length === 0 || query.trim().length > 0)

  const onAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && hasSelectableOptions) {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(index + 1, options.length - 1))
      return
    }
    if (event.key === 'ArrowUp' && hasSelectableOptions) {
      event.preventDefault()
      setHighlightedIndex((index) => Math.max(index - 1, 0))
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && hasSelectableOptions) {
      event.preventDefault()
      const option = options[highlightedIndex] ?? options[0]
      if (option) {
        addRecipient(option)
      }
      return
    }
    if (event.key === 'Backspace' && query.length === 0 && recipients.length > 0) {
      event.preventDefault()
      setRecipients((current) => current.slice(0, -1))
      return
    }
    if (event.key === 'Escape') {
      setQuery('')
    }
  }

  const isPending = startConversation.isPending || sendMessage.isPending
  const showOptions = addressFocused && hasSelectableOptions

  if (!me) {
    return null
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-[17px] font-bold text-[var(--tx)]">
            New chat
          </h1>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-5 py-5">
        <div className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)]">
          <div className="relative border-b border-[color:var(--sep)] p-3">
            <div className="flex min-h-[38px] items-center gap-2">
              <span className="w-8 flex-shrink-0 text-sm font-semibold text-[color:var(--tx2)]">
                To
              </span>
              <div
                className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
                onClick={() => addressInputRef.current?.focus()}
                role="presentation"
              >
                {recipients.map((recipient) => (
                  <span
                    key={optionKey(recipient)}
                    className={[
                      'flex max-w-full items-center gap-1 rounded-md',
                      'bg-[color:var(--overlay)] px-2 py-1 text-sm text-[color:var(--tx)]',
                    ].join(' ')}
                  >
                    <span className="truncate">
                      {getRecipientName(recipient, usersById, agentsById)}
                    </span>
                    <button
                      aria-label={`Remove ${getRecipientName(recipient, usersById, agentsById)}`}
                      className="flex h-4 w-4 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[color:var(--overlay-strong)] hover:text-[color:var(--tx)]"
                      onClick={() => removeRecipient(recipient)}
                      type="button"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  ref={addressInputRef}
                  autoFocus
                  className="min-w-[160px] flex-1 bg-transparent text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]"
                  onBlur={() => window.setTimeout(() => setAddressFocused(false), 120)}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setHighlightedIndex(0)
                  }}
                  onFocus={() => setAddressFocused(true)}
                  onKeyDown={onAddressKeyDown}
                  placeholder={recipients.length === 0 ? 'Add people or agents' : ''}
                  value={query}
                />
              </div>
            </div>

            {showOptions ? (
              <div className="absolute left-12 right-3 top-[calc(100%-4px)] z-50 max-h-72 overflow-y-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--main)] py-1 shadow-xl">
                {options.map((option, index) => (
                  <button
                    key={optionKey(option)}
                    className={[
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                      index === highlightedIndex
                        ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                        : 'text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]',
                    ].join(' ')}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      addRecipient(option)
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    type="button"
                  >
                    {option.kind === 'user' && option.user ? (
                      <UserAvatar
                        avatarAttachmentId={option.user.avatarAttachmentId ?? undefined}
                        avatarUrl={option.user.avatarUrl ?? undefined}
                        displayName={option.user.displayName}
                        gravatarUrl={option.user.gravatarUrl ?? undefined}
                        size={24}
                        token={token}
                      />
                    ) : (
                      <span
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] text-[var(--on-accent)]"
                        style={{ background: agentGradient }}
                      >
                        {option.label.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex flex-col">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-xs opacity-60">{option.detail}</span>
                    </span>
                    <span className="ml-auto text-xs opacity-60">
                      {option.kind}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <form
            className="admin-compose rounded-none border-0"
            onSubmit={(event) => {
              event.preventDefault()
              void submit(mentionRef.current?.getText() ?? message)
            }}
          >
            <MentionInput
              ref={mentionRef}
              entities={mentionEntities}
              maxLength={CHAT_MESSAGE_MAX_CHARS}
              onChange={setMessage}
              onOversizePaste={setOversizePaste}
              onSubmit={(text) => void submit(text)}
              placeholder="Message"
            />
            <div className="flex items-center justify-between border-t border-[color:var(--border-strong)] px-3 py-1.5">
              <div className="text-sm text-[color:var(--danger-text)]">
                {error}
              </div>
              <button
                aria-label="Send message"
                className="flex h-[30px] items-center justify-center rounded-lg bg-[color:var(--accent)] px-3 text-[var(--on-accent)] disabled:opacity-50"
                disabled={recipients.length === 0 || !message.trim() || isPending}
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
      </div>

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
