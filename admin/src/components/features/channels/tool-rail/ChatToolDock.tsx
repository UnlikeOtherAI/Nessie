import { useMemo } from 'react'

import type { AgentRecord } from '../../../../lib/api-client'
import { useAgentConversations } from '../../../../facades/agents/hooks'
import {
  RAIL_POLL_MS,
  WATCHING_POLL_MS,
  useThreadBrowserSessions,
} from '../../../../facades/browser-cloud/hooks'
import { useViewport } from '../../../../hooks/useViewport'
import { useNavigationLayout } from '../../../../navigation/mobile-shell'
import { AgentScreenPanel } from '../../browser-cloud/AgentScreenPanel'
import { AgentConversationsPanel } from '../../agents/conversations/AgentConversationsPanel'
import { ChatToolRail } from './ChatToolRail'
import { availableChatTools, chatToolDoorway, type ChatToolId } from './chat-tools'

type ChatToolDockProps = {
  /** The one agent this conversation is with; the rail is per agent. */
  agent: AgentRecord
  /** The room the reader is standing in — where a new conversation is started. */
  activeChannelId: string | null
  /** The conversation on screen, so its own row is never the reason for a dot. */
  activeThreadId: string | null
  onClose: () => void
  onToggle: (tool: ChatToolId) => void
  openTool: ChatToolId | null
  /**
   * A reply thread or a presented dashboard already holds the right-hand
   * column.
   */
  otherPanelOpen: boolean
  /**
   * This tool is open because the URL says so, not because the rail was
   * pressed — the single-column doorway. A screen the reader navigated to is
   * never crowded out from under them.
   */
  routed: boolean
  threadId: string | null
}

const CROWDED_REASON =
  'No room beside this conversation. Close the thread or dashboard, or widen the window.'

/**
 * The tool rail and the column it opens, as two siblings of the conversation.
 *
 * They are ordinary flex children rather than a layer over the chat: on a wide
 * screen the row reads menu · conversation · reply thread · tool column · rail,
 * and every one of them keeps its own width. On a single-column layout the
 * rail is not drawn at all — `chatToolDoorway` hands the tools to the
 * conversation header there — and the column, which is `SidePanelShell`,
 * becomes a full screen with its own Back.
 */
export const ChatToolDock = ({
  activeChannelId,
  activeThreadId,
  agent,
  onClose,
  onToggle,
  openTool,
  otherPanelOpen,
  routed,
  threadId,
}: ChatToolDockProps) => {
  const single = useNavigationLayout() === 'single'
  const { atLeast } = useViewport()
  // This is the API's projection of the explicit browser_open grant, stated
  // once in the tool table: the Browser dock must use the same fact as the
  // Tools page — a missing grant is an unavailable capability, never a browser
  // read that failed.
  const tools = useMemo(() => availableChatTools(agent), [agent])
  const browserEnabled = tools.some((tool) => tool.id === 'browser')
  // Two 400px panels plus the shell's own 389px of chrome leave a 1280px
  // window 91px of conversation, and below `xl` they are not columns at all —
  // each is a layer over the chat, so a second one means two scrims and a
  // covered panel. Narrower than `2xl`, then, a thread and a tool cannot both
  // stand: the rail says so and stays pressable the moment there is room. It
  // does *not* close the tool, because a window resize is not a decision and
  // must not erase what the reader chose.
  const crowded = otherPanelOpen && !atLeast['2xl'] && !routed
  const browserOpen = browserEnabled && openTool === 'browser' && !crowded
  const conversationsOpen = openTool === 'conversations' && !crowded

  // Watching wants a fresh answer; a rail dot does not, and a layout with no
  // rail wants none at all. Both callers share one query key, so a
  // conversation with the column open polls once, quickly.
  const sessions = useThreadBrowserSessions(threadId, {
    enabled: browserEnabled && (browserOpen || !single),
    refetchInterval: browserOpen ? WATCHING_POLL_MS : RAIL_POLL_MS,
  })
  // This agent's session, not the newest in the thread: the panel is per
  // agent, and a room with several agents must not hand one agent's browser
  // to another's panel — or claim it for a person who resumed a different one.
  const liveSessionId =
    sessions.data?.sessions.find((row) => row.agentId === agent.id)?.id ?? null

  // The same list the column renders, under the same key: the dot and the rows
  // can never disagree, and opening the column costs no second request.
  const conversations = useAgentConversations(agent.id, {
    enabled: conversationsOpen || !single,
    refetchInterval: conversationsOpen ? WATCHING_POLL_MS : RAIL_POLL_MS,
  })
  // "Something is happening *elsewhere*": the conversation on screen already
  // shows its own run in the thinking bubble, so counting it would leave the
  // dot lit for the thread the reader is looking at.
  const otherConversationRunning = conversations.data.some(
    (conversation) => conversation.activeRun !== null && conversation.id !== activeThreadId,
  )

  const liveTools = useMemo(() => {
    const live = new Set<ChatToolId>()
    if (liveSessionId !== null) live.add('browser')
    if (otherConversationRunning) live.add('conversations')
    return live
  }, [liveSessionId, otherConversationRunning])

  return (
    <>
      {conversationsOpen ? (
        <AgentConversationsPanel
          activeChannelId={activeChannelId}
          activeThreadId={activeThreadId}
          agent={agent}
          onClose={onClose}
        />
      ) : null}
      {browserOpen ? (
        <AgentScreenPanel
          agent={agent}
          onClose={onClose}
          sessionId={liveSessionId}
          threadId={threadId}
        />
      ) : null}
      {/*
        One rule decides which control carries the tools, so the rail standing
        down on a phone is the same statement as the header picking them up:
        they can neither double up nor both vanish.
      */}
      {chatToolDoorway({ hasConversationAgent: true, single }) === 'rail' ? (
        <ChatToolRail
          blockedReason={crowded ? CROWDED_REASON : null}
          liveTools={liveTools}
          onToggle={onToggle}
          openTool={crowded ? null : openTool}
          tools={tools}
        />
      ) : null}
    </>
  )
}
