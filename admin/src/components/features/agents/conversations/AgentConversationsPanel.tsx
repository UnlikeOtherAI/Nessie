import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { AgentRecord } from '../../../../lib/api-client'
import { useStartAgentConversation } from '../../../../facades/agents/hooks'
import { WATCHING_POLL_MS } from '../../../../facades/browser-cloud/hooks'
import { useSidePanelGeometry } from '../../../../hooks/useSidePanelGeometry'
import { LOCAL_BACK_PRIORITY, useLocalBack } from '../../../../navigation/LocalBackContext'
import { useNavigationLayout } from '../../../../navigation/mobile-shell'
import { PhoneBackButton } from '../../../../navigation/PhoneBackButton'
import { useNativeBarHeader } from '../../../../navigation/useNativeBarHeader'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { Notice } from '../../../primitives/Notice'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { SidePanelShell } from '../../channels/side-panel/SidePanelShell'
import { THREAD_PANEL_WIDTH_STORAGE_KEY } from '../../channels/thread-panel/thread-panel-layout'
import { AgentConversationList, conversationPath } from './AgentConversationList'
import { focusComposerState } from './conversation-intent'

/**
 * One width for the column whichever agent it is showing, so switching
 * conversations never moves a column the reader had already sized. It is its
 * own key rather than the browser panel's: the two are different columns and a
 * person sizes them for different things.
 */
const CONVERSATIONS_PANEL_WIDTH_STORAGE_KEY = 'nessie.agentConversationsPanelWidth'

type AgentConversationsPanelProps = {
  agent: AgentRecord
  /** The room the reader is standing in — where a new conversation is started. */
  activeChannelId: string | null
  /** The conversation on screen, marked in the list. */
  activeThreadId: string | null
  onClose: () => void
}

/**
 * The agent's conversations, beside the one you are standing in.
 *
 * The same frame as the agent's browser panel (`AgentScreenPanel`) — same
 * shell, same breakpoints, same drag-resize, linked to the reply thread on its
 * left — because it answers the same shape of question and a second set of
 * panel mechanics would drift on the parts nobody looks at twice.
 *
 * The button above the list is the whole point of the column: this is where a
 * second, isolated conversation with the same agent is started. It is created
 * empty, in the room the reader is already in, and the caret lands in its
 * composer.
 */
export const AgentConversationsPanel = ({
  activeChannelId,
  activeThreadId,
  agent,
  onClose,
}: AgentConversationsPanelProps) => {
  const navigate = useNavigate()
  const { token } = useAuthSession()
  const phoneLayout = useNavigationLayout() === 'single'
  // The reply thread stands immediately to this panel's left, and the handle
  // between them belongs to this panel. The hook links the two only while both
  // are on screen, so naming the thread's key costs nothing when there is no
  // thread.
  const geometry = useSidePanelGeometry(CONVERSATIONS_PANEL_WIDTH_STORAGE_KEY, {
    linkedLeftKey: THREAD_PANEL_WIDTH_STORAGE_KEY,
  })
  const startConversation = useStartAgentConversation()
  const [startError, setStartError] = useState<string | null>(null)

  // On a single-column layout the panel is a route and the router owns Back;
  // this registration is for the layouts in between — a narrow tablet, where
  // the shell is `split` but the panel is a full-screen layer opened from the
  // rail — so a hardware Back or an edge swipe closes the panel rather than
  // the conversation under it.
  useLocalBack({
    active: true,
    id: 'chat-tool:conversations',
    label: 'Back to conversation',
    onBack: onClose,
    priority: LOCAL_BACK_PRIORITY.chatToolPanel,
  })

  const { hidden: nativeBarOwnsHeader } = useNativeBarHeader({
    actions: [],
    back: { label: 'Back to conversation', onBack: onClose },
    title: 'Conversations',
  })

  const startNewConversation = () => {
    if (!activeChannelId || startConversation.isPending) return
    setStartError(null)
    startConversation.mutate(
      { agentId: agent.id, channelId: activeChannelId },
      {
        onError: (error: unknown) => {
          setStartError(
            error instanceof Error && error.message
              ? error.message
              : 'Could not start a conversation. Please try again.',
          )
        },
        onSuccess: (result) => {
          // The reader is here to say the first thing, so the composer takes
          // the caret on arrival (`conversation-intent.ts`).
          void navigate(conversationPath(result.conversation), { state: focusComposerState() })
        },
      },
    )
  }

  return (
    <SidePanelShell
      ariaLabel={`Conversations with ${agent.name}`}
      isClosing={false}
      onClose={onClose}
      panelWidth={geometry.panelWidth}
      persistPanelWidth={geometry.persistPanelWidth}
      resizePanel={geometry.resizePanel}
      resizePanelWithKeyboard={geometry.resizePanelWithKeyboard}
      viewportWidth={geometry.viewportWidth}
    >
      {nativeBarOwnsHeader ? null : (
        <header className="flex flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4 py-3">
          {phoneLayout ? (
            <PhoneBackButton label="Back to conversation" onBack={onClose} />
          ) : null}
          <AgentAvatar agent={agent} size="xs" token={token} />
          <h2 className="flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
            Conversations
          </h2>
          {phoneLayout ? null : (
            <button
              aria-label="Close conversations panel"
              className="admin-icon-button"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          )}
        </header>
      )}
      <div className="flex-shrink-0 border-b border-[color:var(--sep)] p-3">
        <button
          className="admin-button admin-button-primary w-full"
          data-testid="start-agent-conversation"
          disabled={startConversation.isPending || activeChannelId === null}
          onClick={startNewConversation}
          type="button"
        >
          {startConversation.isPending ? 'Starting…' : 'New conversation'}
        </button>
        {startError ? (
          <Notice className="mt-2" role="alert" size="sm" tone="danger">
            {startError}
          </Notice>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AgentConversationList
          activeChannelId={activeChannelId}
          activeThreadId={activeThreadId}
          agentId={agent.id}
          refetchInterval={WATCHING_POLL_MS}
        />
      </div>
    </SidePanelShell>
  )
}
