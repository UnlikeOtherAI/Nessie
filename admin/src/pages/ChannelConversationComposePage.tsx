import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CHAT_MESSAGE_MAX_CHARS } from '@nessie/schemas'
import { useAgents } from '../facades/agents/hooks'
import { useStartChannelConversation } from '../facades/channels/hooks'
import { useSendMessageToThread } from '../facades/messages/hooks'
import { useUsers } from '../facades/users/hooks'
import type { AgentRecord, UserRecord } from '../lib/api-client'
import { readChannelComposeReturnTo } from '../lib/channel-compose-navigation'
import {
  buildRecipientOptions,
  recipientKey,
  selectAddressableAgents,
  type Recipient,
  type RecipientOption,
} from '../lib/channel-compose-recipients'
import { usePhoneLayout } from '../lib/mobile-shell'
import { OverlayPortal } from '../components/overlays/OverlayPortal'
import { useOverlay } from '../components/overlays/useOverlay'
import { AgentVisibilityPill } from '../components/features/agents/AgentVisibilityPill'
import { DirectMessageAgentCreator } from '../components/features/channels/DirectMessageAgentCreator'
import {
  DIRECT_MESSAGE_TARGET_VALUES,
  DirectMessageTargetTabs,
  type DirectMessageTarget,
} from '../components/features/channels/DirectMessageTargetTabs'
import { UserAvatar } from '../components/primitives/UserAvatar'
import { AgentAvatar } from '../components/shared/AgentAvatar'
import {
  MentionInput,
  type AgentMention,
  type MentionEntity,
  type MentionInputHandle,
} from '../components/shared/MentionInput'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useIsOwner } from '../components/shared/OwnerGate'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { VoiceDictationControl } from '../components/features/channels/VoiceDictationControl'
import { type VoiceDictationState, voiceDictationBlocksSubmit } from '../components/features/channels/voice-dictation-state'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { useTabParam } from '../navigation/useTabParam'

const optionKey = recipientKey

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
  const location = useLocation()
  const navigate = useNavigate()
  const phoneLayout = usePhoneLayout()
  const { me, token } = useAuthSession()
  const isOwner = useIsOwner()
  const { data: allUsers = [] } = useUsers(isOwner)
  // `scope: 'all'` is the arm that includes the read-only system tier. The
  // default list excludes every `systemManaged` agent, which is why no global
  // agent and no Personal Assistant could ever appear in this address book.
  const { data: allAgents = [] } = useAgents({ scope: 'all' })
  const startConversation = useStartChannelConversation()
  const sendMessage = useSendMessageToThread()
  const mentionRef = useRef<MentionInputHandle>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)

  const [target, setTarget] = useTabParam(
    'with',
    DIRECT_MESSAGE_TARGET_VALUES,
    'people',
  )
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [newAgentVisibility, setNewAgentVisibility] = useState<'private' | 'team'>('private')
  const [query, setQuery] = useState('')
  const [addressFocused, setAddressFocused] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)
  const [leavingForDesigner, setLeavingForDesigner] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceDictationState>('idle')

  const returnTo = readChannelComposeReturnTo(location.state)
  const close = useCallback(() => {
    void navigate(returnTo, { replace: true })
  }, [navigate, returnTo])
  // A route, not a popup — the phone-navigation stack already owns Back for
  // it there (docs/navigation/overview.md §6), so it registers as a modal overlay only
  // on `split`, where it visually IS a centred dialog over the channel list.
  // Never a breakpoint read of its own: `phoneLayout` is the layout question
  // this page already answers for its own scrim/full-screen branch.
  const overlay = useOverlay({
    id: 'channel-conversation-compose',
    initialFocusRef: addressInputRef,
    kind: 'modal',
    label: 'Close new message',
    onClose: close,
    open: !phoneLayout,
  })

  const users = useMemo<UserRecord[]>(() => {
    return allUsers.filter((user) => user.id !== me?.user.id)
  }, [allUsers, me])

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  )
  const agents = useMemo(
    () => selectAddressableAgents(allAgents, { isOwner }),
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
  const options = useMemo<RecipientOption[]>(
    () => buildRecipientOptions({
      agents: target === 'agents' ? agents : [],
      limit: 8,
      query,
      selectedKeys,
      users: target === 'people' ? users : [],
    }),
    [agents, query, selectedKeys, target, users],
  )

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

  const selectTarget = useCallback((next: DirectMessageTarget) => {
    setTarget(next)
    setQuery('')
    setHighlightedIndex(0)
    window.setTimeout(() => addressInputRef.current?.focus(), 0)
  }, [setTarget])

  const continueToAgentDesigner = useCallback(() => {
    // This Flow is a portal on split layouts. The navigation stack retains its
    // outgoing screen as an underlay, so remove the Flow from the current
    // entry before pushing the Designer; otherwise its portal escapes that
    // underlay's inert/hidden boundary and keeps covering the destination.
    setLeavingForDesigner(true)
    void navigate(returnTo, { flushSync: true, replace: true })
    window.setTimeout(() => {
      void navigate(`/agents/designer?visibility=${newAgentVisibility}`, {
        state: { returnTo },
      })
    }, 0)
  }, [navigate, newAgentVisibility, returnTo])

  const submit = useCallback(
    async (rawText: string, agentMentions: AgentMention[] = []) => {
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
          ...(agentMentions.length > 0 ? { agentMentions } : {}),
          content,
          threadId: channel.defaultThreadId,
        })
        mentionRef.current?.clear()
        setMessage('')
        void navigate(`/channels/${channel.id}`, { replace: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start chat.')
      }
    },
    [navigate, recipients, sendMessage, startConversation],
  )

  const hasSelectableOptions = options.length > 0

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
  if (leavingForDesigner) return null

  return (
    <OverlayPortal active={!phoneLayout}>
      <div
        {...(phoneLayout ? {} : overlay.scrimProps)}
        className={phoneLayout
          ? 'fixed inset-0 bg-[color:var(--main)]'
          : 'fixed inset-0 flex items-center justify-center bg-[var(--scrim-strong)] p-6 backdrop-blur-sm'}
        role="presentation"
        style={overlay.layerStyle}
      >
        <div
          aria-labelledby="channel-conversation-compose-title"
          aria-modal={phoneLayout ? undefined : true}
          className={phoneLayout
            ? 'flex h-[100dvh] min-h-0 w-full flex-col bg-[color:var(--main)] pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]'
            : 'flex h-[46rem] max-h-[calc(100dvh-3rem)] min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] shadow-2xl'}
          ref={overlay.panelRef}
          role="dialog"
          tabIndex={phoneLayout ? undefined : -1}
        >
          {/* The one header, at the shell's height rather than this flow's own
              58px. A Flow returning to an explicit address owns its Back, so on
              the single layout the leading control is this page's close; on
              split — where the flow is a centred dialog — the same action is a
              Close in the actions lane. */}
          <ScreenHeader
            actions={phoneLayout ? [] : [{
              compact: true,
              icon: faXmark,
              id: 'close-compose',
              label: 'Close new message',
              onSelect: close,
              priority: 100,
            }]}
            backLabel="Back to Channels"
            flowOwnsBack
            onBack={phoneLayout ? close : undefined}
            title="New message"
            titleId="channel-conversation-compose-title"
          />

          <DirectMessageTargetTabs onChange={selectTarget} value={target} />

          <div
            aria-labelledby={`direct-message-target-tab-${target}`}
            className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-5 py-5"
            id={`direct-message-target-tabpanel-${target}`}
            role="tabpanel"
          >
          {target === 'agents' ? (
            <DirectMessageAgentCreator
              onContinue={continueToAgentDesigner}
              onVisibilityChange={setNewAgentVisibility}
              visibility={newAgentVisibility}
            />
          ) : null}
          {target === 'agents' ? (
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]">
              Or message an existing agent
            </p>
          ) : null}
          <div className="relative flex-shrink-0 rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
            <div className="flex min-h-[38px] items-center gap-2">
              <span className="w-8 flex-shrink-0 text-sm font-semibold text-[color:var(--tx2)]">
                To
              </span>
              <div
                className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
                onClick={() => {
                  setAddressFocused(true)
                  addressInputRef.current?.focus()
                }}
                role="presentation"
              >
                {recipients.map((recipient) => {
                  const selectedAgent = recipient.kind === 'agent'
                    ? agentsById.get(recipient.id)
                    : undefined
                  return (
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
                      {selectedAgent ? (
                        <AgentVisibilityPill visibility={selectedAgent.visibility} />
                      ) : null}
                      <button
                        aria-label={`Remove ${getRecipientName(recipient, usersById, agentsById)}`}
                        className="flex h-4 w-4 items-center justify-center rounded text-[color:var(--tx3)] hover:bg-[color:var(--overlay-strong)] hover:text-[color:var(--tx)]"
                        onClick={() => removeRecipient(recipient)}
                        type="button"
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
                <input
                  ref={addressInputRef}
                  autoFocus
                  className="min-w-[160px] flex-1 bg-transparent text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]"
                  onBlur={() => window.setTimeout(() => {
                    if (document.activeElement !== addressInputRef.current) {
                      setAddressFocused(false)
                    }
                  }, 120)}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setHighlightedIndex(0)
                  }}
                  onFocus={() => setAddressFocused(true)}
                  onKeyDown={onAddressKeyDown}
                  placeholder={recipients.length === 0
                    ? (target === 'people' ? 'Type a name or email address' : 'Type an agent name')
                    : ''}
                  value={query}
                />
              </div>
            </div>

            {showOptions ? (
              <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-72 overflow-y-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] py-1 shadow-xl">
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
                        size={24}
                        token={token}
                        userId={option.user.id}
                      />
                    ) : (
                      <AgentAvatar agentId={option.id} size={24} token={token} />
                    )}
                    <span className="min-w-0 flex flex-col">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-xs opacity-60">{option.detail}</span>
                    </span>
                    <span className="ml-auto flex-shrink-0">
                      {option.kind === 'agent' && option.agentVisibility ? (
                        <AgentVisibilityPill visibility={option.agentVisibility} />
                      ) : (
                        <span className="text-xs opacity-60">{option.category}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <form
            className="admin-compose mt-auto flex-shrink-0"
            // The soft-keyboard inset (docs/navigation/overview.md §4.14) keeps this
            // composer above an on-screen keyboard on hosts whose `dvh` does
            // not itself shrink for it.
            style={{ marginBottom: 'var(--keyboard-inset, 0px)' }}
            onSubmit={(event) => {
              event.preventDefault()
              if (voiceDictationBlocksSubmit(voiceState)) return
              void submit(mentionRef.current?.getText() ?? message)
            }}
          >
            <MentionInput
              ref={mentionRef}
              entities={mentionEntities}
              maxLength={CHAT_MESSAGE_MAX_CHARS}
              onChange={setMessage}
              onOversizePaste={setOversizePaste}
              onSubmit={(text, agentMentions) => void submit(text, agentMentions)}
              placeholder="Message"
              submitDisabled={voiceDictationBlocksSubmit(voiceState)}
            />
            <div className="flex items-center justify-between border-t border-[color:var(--border-strong)] px-3 py-1.5">
              <div className="text-sm text-[color:var(--danger-text)]">
                {error}
              </div>
              <div className="flex items-center gap-2">
                <VoiceDictationControl
                  disabled={isPending}
                  onInsertTranscript={(text) => {
                    mentionRef.current?.insertDictationText(text)
                    mentionRef.current?.focus()
                  }}
                  onStateChange={setVoiceState}
                />
                <button
                  aria-label="Send message"
                  className="admin-compose-send flex h-[30px] items-center justify-center rounded-lg bg-[color:var(--accent)] px-3 text-[var(--on-accent)] disabled:opacity-50"
                  disabled={
                    recipients.length === 0
                    || !message.trim()
                    || isPending
                    || voiceDictationBlocksSubmit(voiceState)
                  }
                  type="submit"
                >
                  <svg
                    className="admin-compose-action-icon h-4 w-4"
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
            </div>
          </form>
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
        </div>
      </div>
    </OverlayPortal>
  )
}
