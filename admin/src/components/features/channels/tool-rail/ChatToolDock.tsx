import { useCallback, useEffect, useMemo, useState } from 'react'

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
import {
  anyConversationRunning,
  availableChatTools,
  chatToolAgentsToWatch,
  chatToolDoorway,
  hasOtherRunningConversation,
  type ChatToolId,
} from './chat-tools'

type ChatToolDockProps = {
  /**
   * The agents whose tools this room offers (`resolveChatToolAgents`), in the
   * order they were bound.
   */
  agents: readonly AgentRecord[]
  /** Which of them the column is about; the rail's state is keyed on it. */
  selectedAgent: AgentRecord
  onSelectAgent: (agentId: string) => void
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

type ConversationRunWatcherProps = {
  activeThreadId: string | null
  agentId: string
  enabled: boolean
  onChange: (agentId: string, running: boolean) => void
  refetchInterval: number
}

/**
 * One agent's conversations, watched for the rail's dot and drawing nothing.
 *
 * A room can hold several agents and the dot speaks for all of them, so the
 * read is one component per agent rather than a hook the dock could not call
 * in a loop. The selected agent's watcher shares its query key with the column
 * itself, so opening the column costs no second request.
 */
const ConversationRunWatcher = ({
  activeThreadId,
  agentId,
  enabled,
  onChange,
  refetchInterval,
}: ConversationRunWatcherProps) => {
  const conversations = useAgentConversations(agentId, { enabled, refetchInterval })
  const running = hasOtherRunningConversation(conversations.data, activeThreadId)

  useEffect(() => {
    onChange(agentId, running)
  }, [agentId, onChange, running])

  return null
}

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
  agents,
  onClose,
  onSelectAgent,
  onToggle,
  openTool,
  otherPanelOpen,
  routed,
  selectedAgent,
  threadId,
}: ChatToolDockProps) => {
  const single = useNavigationLayout() === 'single'
  const { atLeast } = useViewport()
  // This is the API's projection of the explicit browser_open grant, stated
  // once in the tool table: the Browser dock must use the same fact as the
  // Tools page — a missing grant is an unavailable capability, never a browser
  // read that failed. In a room with several agents there is no browser at
  // all, because there is no answer to "whose".
  const tools = useMemo(() => availableChatTools(agents), [agents])
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
    sessions.data?.sessions.find((row) => row.agentId === selectedAgent.id)?.id ?? null

  // "Something is happening *elsewhere*", for every agent the rail names — a
  // room's second agent running a job is exactly what the dot is for. Past
  // `CHAT_TOOL_AGENT_WATCH_LIMIT` only the selected agent is polled: the dot is
  // a hint, and a dozen agents must not become a dozen requests per tick.
  const watched = useMemo(
    () => chatToolAgentsToWatch(agents, selectedAgent.id),
    [agents, selectedAgent.id],
  )
  const [runningByAgentId, setRunningByAgentId] = useState<Record<string, boolean>>({})
  const reportRunning = useCallback((agentId: string, running: boolean) => {
    setRunningByAgentId((current) =>
      current[agentId] === running ? current : { ...current, [agentId]: running },
    )
  }, [])
  const otherConversationRunning = anyConversationRunning(runningByAgentId, agents)

  const liveTools = useMemo(() => {
    const live = new Set<ChatToolId>()
    if (liveSessionId !== null) live.add('browser')
    if (otherConversationRunning) live.add('conversations')
    return live
  }, [liveSessionId, otherConversationRunning])

  return (
    <>
      {watched.map((agent) => (
        <ConversationRunWatcher
          activeThreadId={activeThreadId}
          agentId={agent.id}
          enabled={conversationsOpen || !single}
          key={agent.id}
          onChange={reportRunning}
          refetchInterval={conversationsOpen ? WATCHING_POLL_MS : RAIL_POLL_MS}
        />
      ))}
      {conversationsOpen ? (
        <AgentConversationsPanel
          activeChannelId={activeChannelId}
          activeThreadId={activeThreadId}
          agent={selectedAgent}
          agents={agents}
          onClose={onClose}
          onSelectAgent={onSelectAgent}
        />
      ) : null}
      {browserOpen ? (
        <AgentScreenPanel
          agent={selectedAgent}
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
      {chatToolDoorway({ hasToolAgents: true, single }) === 'rail' ? (
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
