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
import {
  MentionInput,
  type AgentMention,
  type MentionEntity,
  type MentionInputHandle,
} from '../components/shared/MentionInput'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useIsOrganizationAdmin } from '../facades/auth/hooks'
import { RecipientBar } from '../components/shared/RecipientBar'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useAuthSession } from '../providers/AuthSessionProvider'

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
  // Owner OR admin: the same standing `POST /api/channels/conversations`
  // requires when the body names agents. The two must agree, or the picker
  // offers a recipient the route refuses.
  const isAdmin = useIsOrganizationAdmin()
  const { data: allUsers = [] } = useUsers()
  // `scope: 'all'` is the arm that includes the read-only system tier. The
  // default list excludes every `systemManaged` agent, which is why no global
  // agent and no Personal Assistant could ever appear in this address book.
  const { data: allAgents = [] } = useAgents({ scope: 'all' })
  const startConversation = useStartChannelConversation()
  const sendMessage = useSendMessageToThread()
  const mentionRef = useRef<MentionInputHandle>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oversizePaste, setOversizePaste] = useState<string | null>(null)

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
    () => selectAddressableAgents(allAgents, { isAdmin }),
    [allAgents, isAdmin],
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

          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-5 py-5">
          {/* One address book: people and agents are offered side by side, and
              any mix of them can be addressed in the same message. */}
          <div className="flex-shrink-0">
            <RecipientBar
              agents={agents}
              autoFocus
              inputRef={addressInputRef}
              label="To"
              // People are listed first, so a short cap would push every agent
              // out of reach until the person typed; the list scrolls instead.
              limit={50}
              onChange={setRecipients}
              placeholder="Type a name, email address or agent"
              recipients={recipients}
              token={token}
              users={users}
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
