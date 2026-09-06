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
  selectAddressableAgents,
  type Recipient,
} from '../lib/channel-compose-recipients'
import { usePhoneLayout } from '../navigation/mobile-shell'
import { OverlayPortal } from '../components/overlays/OverlayPortal'
import { useOverlay } from '../components/overlays/useOverlay'
import { DirectMessageAgentCreator } from '../components/features/channels/DirectMessageAgentCreator'
import {
  DIRECT_MESSAGE_TARGET_VALUES,
  DirectMessageTargetTabs,
  type DirectMessageTarget,
} from '../components/features/channels/DirectMessageTargetTabs'
import {
  MentionInput,
  type AgentMention,
  type MentionEntity,
  type MentionInputHandle,
} from '../components/shared/MentionInput'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useIsOwner } from '../facades/auth/hooks'
import { RecipientBar } from '../components/shared/RecipientBar'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { useTabParam } from '../navigation/useTabParam'

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
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)
  const [leavingForDesigner, setLeavingForDesigner] = useState(false)

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



  const selectTarget = useCallback((next: DirectMessageTarget) => {
    setTarget(next)
    // The address bar owns its own query and highlight; switching sides only
    // changes what it is offered, and the caret belongs back in the field.
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



  const isPending = startConversation.isPending || sendMessage.isPending

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
          <div className="flex-shrink-0">
            <RecipientBar
              agents={target === 'agents' ? agents : []}
              autoFocus
              inputRef={addressInputRef}
              label="To"
              onChange={setRecipients}
              placeholder={target === 'people' ? 'Type a name or email address' : 'Type an agent name'}
              recipients={recipients}
              token={token}
              users={target === 'people' ? users : []}
            />
          </div>

          <form
            className="admin-compose mt-auto flex-shrink-0"
            // The soft-keyboard inset (docs/navigation/overview.md §4.14) keeps this
            // composer above an on-screen keyboard on hosts whose `dvh` does
            // not itself shrink for it.
            style={{ marginBottom: 'var(--keyboard-inset, 0px)' }}
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
              onSubmit={(text, agentMentions) => void submit(text, agentMentions)}
              placeholder="Message"
            />
            <div className="flex items-center justify-between border-t border-[color:var(--border-strong)] px-3 py-1.5">
              <div className="text-sm text-[color:var(--danger-text)]">
                {error}
              </div>
              <button
                aria-label="Send message"
                className="admin-compose-send flex h-[30px] items-center justify-center rounded-lg bg-[color:var(--accent)] px-3 text-[var(--on-accent)] disabled:opacity-50"
                disabled={recipients.length === 0 || !message.trim() || isPending}
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
