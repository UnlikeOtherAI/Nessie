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
import { useFileDrop } from '../hooks/useFileDrop'
import { OverlayOwnerProvider } from '../components/overlays/overlay-owner'
import { OverlayPortal } from '../components/overlays/OverlayPortal'
import { useOverlay } from '../components/overlays/useOverlay'
import type {
  AgentMention,
  MentionEntity,
  MentionInputHandle,
} from '../components/shared/MentionInput'
import { DropZoneOverlay } from '../components/shared/DropZoneOverlay'
import { OversizePasteDialog } from '../components/shared/OversizePasteDialog'
import { useIsOrganizationAdmin } from '../facades/auth/hooks'
import { RecipientBar } from '../components/shared/RecipientBar'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { ChannelComposer } from '../components/features/channels/ChannelComposer'
import { useComposerAttachments } from '../components/features/channels/useComposerAttachments'
import { NO_MENTION_INVITE } from '../components/features/channels/useMentionInviteGate'
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
  // Staged exactly as in any conversation — paste, the paperclip, a drop —
  // and linked by the first message, which is what makes them its files.
  const attachments = useComposerAttachments()
  const drop = useFileDrop(attachments.addFiles)
  // One start at a time. Enter clears the editor but not the staged files, so
  // a second Enter while the first start is in flight would send them again.
  const sending = useRef(false)

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

  // Enter empties the editor before the send is attempted (`MentionInput`), so
  // a send that did not happen puts the words back; the staged files never
  // left, because they are cleared only once the message holds them.
  const restoreText = useCallback((text: string) => {
    if (!text || mentionRef.current?.getText().trim()) return
    mentionRef.current?.setText(text)
    setMessage(text)
  }, [])

  const submit = useCallback(
    async (rawText: string, agentMentions: AgentMention[] = []) => {
      const content = rawText.trim()
      const attachmentIds = attachments.attachmentIds
      // Text, finished uploads, or both — the same rule as every composer.
      if ((!content && attachmentIds.length === 0) || sending.current) {
        return
      }
      if (recipients.length === 0) {
        restoreText(content)
        setError('Choose at least one recipient.')
        addressInputRef.current?.focus()
        return
      }

      sending.current = true
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
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          content,
          threadId: channel.defaultThreadId,
        })
        mentionRef.current?.clear()
        setMessage('')
        attachments.clearStaged()
        // The thread this message was written in, not the bare room: an agent
        // DM's bare address is its session home, which does not show it.
        void navigate(`/channels/${channel.id}/threads/${channel.defaultThreadId}`, { replace: true })
      } catch (err) {
        restoreText(content)
        setError(err instanceof Error ? err.message : 'Could not start chat.')
      } finally {
        sending.current = false
      }
    },
    [attachments, navigate, recipients, restoreText, sendMessage, startConversation],
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
            ? 'relative flex h-[100dvh] min-h-0 w-full flex-col bg-[color:var(--main)] pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)]'
            : 'relative flex h-[46rem] max-h-[calc(100dvh-3rem)] min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--main)] shadow-2xl'}
          ref={overlay.panelRef}
          role="dialog"
          tabIndex={phoneLayout ? undefined : -1}
          {...drop.dropHandlers}
        >
          {/* On split this panel is a modal, so what the composer anchors to
              it — the emoji picker — takes the modal-owned layer rather than
              opening under this scrim (docs/navigation/overlays.md). On single
              it is an ordinary screen and owns nothing. */}
          <OverlayOwnerProvider value={phoneLayout ? null : 'modal'}>
            {/* The one header, at the shell's height rather than this flow's
                own 58px. A Flow returning to an explicit address owns its
                Back, so on the single layout the leading control is this
                page's close; on split — where the flow is a centred dialog —
                the same action is a Close in the actions lane. */}
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

            <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
              {/* One address book: people and agents are offered side by side,
                  and any mix of them can be addressed in the same message. */}
              <div className="flex-shrink-0 px-5 pt-5">
                <RecipientBar
                  agents={agents}
                  autoFocus
                  inputRef={addressInputRef}
                  label="To"
                  // People are listed first, so a short cap would push every
                  // agent out of reach until the person typed; the list
                  // scrolls instead.
                  limit={50}
                  onChange={setRecipients}
                  placeholder="Search people or agents"
                  recipients={recipients}
                  token={token}
                  users={users}
                />
              </div>

              {/* The one composer (docs/standards/design-system.md), so a new
                  conversation's first message is written with everything any
                  other message is: paste, the paperclip, emoji, dictation. It
                  brings its own gutter and the soft-keyboard inset. */}
              <div className="mt-auto flex-shrink-0">
                <ChannelComposer
                  attachments={attachments}
                  isSendPending={isPending}
                  mentionEntities={mentionEntities}
                  mentionRef={mentionRef}
                  message={message}
                  onChangeMessage={setMessage}
                  onInsertAtSign={() => mentionRef.current?.insertAtSign()}
                  onInsertEmoji={(emoji) => {
                    mentionRef.current?.insertText(emoji)
                    mentionRef.current?.focus()
                  }}
                  onInsertHashSign={() => mentionRef.current?.insertHashSign()}
                  onOversizePaste={setOversizePaste}
                  onSubmitForm={(event) => {
                    event?.preventDefault()
                    void submit(
                      mentionRef.current?.getText() ?? message,
                      mentionRef.current?.getAgentMentions() ?? [],
                    )
                  }}
                  onSubmitText={(text, agentMentions) => void submit(text, agentMentions)}
                  placeholder="Message"
                  sendError={error}
                  // The questions a send can raise in an existing conversation
                  // do not arise before one exists. Every mention here names a
                  // recipient, and the send makes each a member, so nobody can
                  // be mentioned in from outside and no agent is left unbound.
                  // This page also does not hold a typed credential for the
                  // vault the way a conversation's composer does, so there is
                  // no capture to show.
                  mentionInvite={NO_MENTION_INVITE}
                  pendingAgentInvites={[]}
                  invitingAgentId={null}
                  inviteErrors={{}}
                  onInvitePendingAgent={() => undefined}
                  onDismissPendingAgent={() => undefined}
                  secretCapture={null}
                  onConfirmSecretCapture={async () => undefined}
                  onDismissSecretCapture={() => undefined}
                />
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
            <DropZoneOverlay active={drop.isDragging} label="Drop files to attach" />
          </OverlayOwnerProvider>
        </div>
      </div>
    </OverlayPortal>
  )
}
