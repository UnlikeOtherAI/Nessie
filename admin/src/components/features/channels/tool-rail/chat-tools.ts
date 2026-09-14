/**
 * The tools the agents in a room put within reach.
 *
 * The rail beside the chat, the conversation header on a single-column layout
 * and the conversation info screen's list all read this table, so the doorways
 * cannot drift apart. It is not the whole of adding a tool: a new entry also
 * needs its mark in `ChatToolRail` and the column it opens in `ChatToolDock`.
 *
 * The subject is a *set* of agents rather than one. A project channel with two
 * agents bound to it is exactly where "from my project, my group chat" is
 * asked, and it had no doorway at all while the rail insisted on a single
 * subject (`resolveConversationAgent`, which still decides the Agent / To-dos /
 * Triggers tabs — those genuinely need one subject and are left alone).
 */

import { faComments, faTableColumns } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { AgentRecord } from '../../../../lib/api-client'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'

// The list first, the browser second: one is *the agent's work* and the other
// is a tool it uses. The order is the rail's order, the header doorway's order,
// and the order the iOS bar picks its one inline slot from.
export const CHAT_TOOL_IDS = ['conversations', 'browser'] as const

export type ChatToolId = (typeof CHAT_TOOL_IDS)[number]

export type ChatTool = {
  id: ChatToolId
  label: string
  /**
   * What opening it answers, in one line — it is the detail under the label on
   * the conversation info screen, which truncates, so it stays short and says
   * nothing the column cannot deliver.
   */
  description: string
  /**
   * Whether these agents, taken together, have this tool. A capability, read
   * from the agent records — never a guess and never a layout question.
   * Conversations belongs to the set (the column picks which agent's list to
   * show); a browser is per agent, and a room with two agents has two of them,
   * so it is offered only where there is no question which one is meant.
   */
  available: (agents: readonly AgentRecord[]) => boolean
  /** The web header's glyph on a layout with no rail to draw the mark in. */
  icon: IconDefinition
}

export const CHAT_TOOLS: readonly ChatTool[] = [
  {
    available: (agents) => agents.length > 0,
    description:
      'Every conversation with this agent you can see — switch between them or start another.',
    icon: faComments,
    id: 'conversations',
    label: 'Conversations',
  },
  {
    // This is the API's projection of the explicit `browser_open` grant. A
    // missing grant is an unavailable capability, never a browser read that
    // failed. And a browser column is one agent's screen — `GET /api/threads/
    // :id/browser-sessions` is filtered by agent id — so in a room with
    // several agents it is withheld rather than guessed at.
    available: (agents) => agents.length === 1 && agents[0]?.browserEnabled === true,
    description: 'Its own browser — watch it work, or pick up where it left off.',
    icon: faTableColumns,
    id: 'browser',
    label: 'Browser',
  },
]

/**
 * Whose tools the rail is offering, decided structurally from where the reader
 * is standing rather than from the shape of the room.
 *
 * - Inside a conversation, the thread's own agent and nobody else: the thread
 *   is *with* it (`threads.agent_id`), so the tools beside it are its own.
 * - A DM or the assistant's own room: the one agent that conversation is with.
 * - Any other room: the agents bound to it, in the order they were bound.
 *
 * An empty set draws no rail, exactly as a room with no agent does today. A
 * conversation whose agent record has not resolved yet falls through to the
 * room's own agents rather than to nothing, so the rail does not blink out
 * while a read lands.
 */
export const resolveChatToolAgents = ({
  boundAgents,
  conversationAgent,
  conversationThreadAgent,
  inConversation,
}: {
  /** Every agent bound to the room on screen. */
  boundAgents: readonly AgentRecord[]
  /** The single subject of a DM or the assistant's room, where there is one. */
  conversationAgent: AgentRecord | null
  /** The agent the open conversation thread is with. */
  conversationThreadAgent: AgentRecord | null
  /** Whether the thread on screen is a conversation rather than the room's own. */
  inConversation: boolean
}): AgentRecord[] => {
  if (inConversation && conversationThreadAgent !== null) return [conversationThreadAgent]
  if (conversationAgent !== null) return [conversationAgent]
  return [...boundAgents]
}

/**
 * The tools these agents actually have, in table order. An agent with no
 * browser gets a rail of one rather than a button that explains it cannot open.
 */
export const availableChatTools = (agents: readonly AgentRecord[]): readonly ChatTool[] =>
  CHAT_TOOLS.filter((tool) => tool.available(agents))

/** Which control carries the tools on a given layout. */
export type ChatToolDoorway = 'header' | 'none' | 'rail'

/**
 * Where a room's agent tools are reachable from.
 *
 * The rail and the conversation header are complements, never alternatives:
 * whichever one is not carrying the tools draws nothing, so a tool is offered
 * exactly once — and never, as it was on the iOS phone app, nowhere. There the
 * rail correctly stands down on a single-column layout, and the only doorway
 * left was a row on the conversation info screen: two screens in, behind the
 * native bar's `···` sheet, which is not a place anybody finds a browser.
 */
export const chatToolDoorway = ({
  hasToolAgents,
  single,
}: {
  /** Whether `resolveChatToolAgents` found anyone whose tools these are. */
  hasToolAgents: boolean
  single: boolean
}): ChatToolDoorway => {
  if (!hasToolAgents) return 'none'
  return single ? 'header' : 'rail'
}

/**
 * How high the doorway sits among the conversation's own header actions: above
 * everything but Join, which is the one control that has to be answered before
 * the conversation is usable at all.
 */
export const CHAT_TOOL_ACTION_PRIORITY = 95

/**
 * The tools as conversation-header actions, on the layout whose doorway is the
 * header — and an empty list everywhere else, where the rail carries them.
 *
 * `primary` is load-bearing rather than emphasis. It is the only flag that
 * keeps a control on screen at every width: `partitionPageHeaderActions` never
 * moves a primary action into "More", and the iOS navigation bar draws the
 * primary action beside its `···` button and sweeps everything else into the
 * sheet behind it. Any other flag puts this doorway back inside a menu, which
 * is where it was lost.
 *
 * Selecting one navigates rather than toggling a column: on a single-column
 * layout the tool is a real screen, so Back, a deep link and the native stack
 * all resolve. The caller owns that navigation, so there is still exactly one
 * implementation of "open this agent's tool" (`ChannelsPage`).
 */
export const chatToolHeaderActions = ({
  agents,
  onOpenTool,
  single,
}: {
  /** The agents whose tools this room offers (`resolveChatToolAgents`). */
  agents: readonly AgentRecord[]
  onOpenTool: (tool: ChatToolId) => void
  single: boolean
}): PageHeaderAction[] =>
  chatToolDoorway({ hasToolAgents: agents.length > 0, single }) === 'header'
    ? availableChatTools(agents).map((tool) => ({
        // The two-pane glyph, in the native bar's one vocabulary: the
        // conversation on the left and the panel it opens on the right, which
        // is what pressing it does — the screen arrives from the right over the
        // conversation (`navigation/motion.ts`, `topAt(1)` =
        // translate3d(100%, 0, 0)). Both tools open a panel from the right, so
        // both carry it; the web header draws each tool's own glyph, and
        // `label` stays the accessible name everywhere.
        barIcon: 'panel-right' as const,
        // Icon-only, like every other control in this header. Two labelled
        // pills squeezed the conversation's own title to zero width on a
        // 390px phone — measured, not guessed — and a header that names the
        // tools but not the screen is the wrong trade. The label stays the
        // accessible name and the tooltip.
        compact: true,
        icon: tool.icon,
        id: `chat-tool-${tool.id}`,
        label: tool.label,
        onSelect: () => onOpenTool(tool.id),
        primary: true,
        priority: CHAT_TOOL_ACTION_PRIORITY,
        title: tool.description,
      }))
    : []

const isChatToolId = (value: string): value is ChatToolId =>
  (CHAT_TOOL_IDS as readonly string[]).includes(value)

/**
 * Which tool a person left open, per agent.
 *
 * Per agent rather than per conversation because the tools belong to the
 * agent: the same browser is the same browser whichever room you reached it
 * from. The value is a layout preference, not navigation state — nobody should
 * be able to link somebody else into a column that may not exist for them —
 * so it lives in `localStorage` rather than the URL.
 */
export const chatToolStorageKey = (agentId: string): string =>
  `nessie.chatTool.${agentId}`

/** Tolerates a missing key, a retired tool id, and hand-edited garbage. */
export const parseOpenChatTool = (stored: string | null): ChatToolId | null =>
  stored !== null && isChatToolId(stored) ? stored : null

export const readOpenChatTool = (agentId: string | null): ChatToolId | null => {
  if (agentId === null) return null
  try {
    return parseOpenChatTool(window.localStorage.getItem(chatToolStorageKey(agentId)))
  } catch {
    // Storage blocked (private window, embedded WebView): the rail simply
    // starts closed rather than failing to render.
    return null
  }
}

export const writeOpenChatTool = (agentId: string | null, tool: ChatToolId | null): void => {
  if (agentId === null) return
  try {
    if (tool === null) window.localStorage.removeItem(chatToolStorageKey(agentId))
    else window.localStorage.setItem(chatToolStorageKey(agentId), tool)
  } catch {
    // A preference that cannot be stored is still honoured for this session.
  }
}

/**
 * Which of a room's agents the column is showing, per room.
 *
 * Per room rather than per agent — it is a choice *between* the room's agents,
 * so it has no meaning anywhere else — and in `localStorage` for the same
 * reason the open tool is: a column choice is a layout preference, not
 * something to link somebody else into.
 */
export const chatToolAgentStorageKey = (channelId: string): string =>
  `nessie.chatToolAgent.${channelId}`

/**
 * Tolerates a missing key, hand-edited garbage, and an id that no longer names
 * an agent in this room — an agent can be unbound between two visits, and a
 * stored id that outlives its binding must read as "no choice yet" rather than
 * emptying the column.
 */
export const parseChatToolAgentId = (
  stored: string | null,
  agents: readonly AgentRecord[],
): string | null =>
  stored !== null && agents.some((agent) => agent.id === stored) ? stored : null

/** The stored choice if it is still on offer, else the first bound agent. */
export const selectedChatToolAgent = (
  agents: readonly AgentRecord[],
  storedAgentId: string | null,
): AgentRecord | null => {
  const chosen = parseChatToolAgentId(storedAgentId, agents)
  return agents.find((agent) => agent.id === chosen) ?? agents[0] ?? null
}

export const readChatToolAgentId = (channelId: string | null): string | null => {
  if (channelId === null) return null
  try {
    return window.localStorage.getItem(chatToolAgentStorageKey(channelId))
  } catch {
    // Storage blocked: the column simply opens on the first bound agent.
    return null
  }
}

export const writeChatToolAgentId = (channelId: string | null, agentId: string): void => {
  if (channelId === null) return
  try {
    window.localStorage.setItem(chatToolAgentStorageKey(channelId), agentId)
  } catch {
    // A preference that cannot be stored is still honoured for this session.
  }
}

/**
 * How many agents' lists the rail is willing to poll for its live dot. Beyond
 * this only the selected one is watched: the dot is a hint, and a room with a
 * dozen agents must not turn a rail into a dozen requests every `RAIL_POLL_MS`.
 */
export const CHAT_TOOL_AGENT_WATCH_LIMIT = 4

export const chatToolAgentsToWatch = (
  agents: readonly AgentRecord[],
  selectedAgentId: string | null,
): AgentRecord[] =>
  agents.length > CHAT_TOOL_AGENT_WATCH_LIMIT
    ? agents.filter((agent) => agent.id === selectedAgentId)
    : [...agents]

/**
 * One agent's half of the Conversations dot: something is happening
 * *elsewhere*. The conversation on screen already shows its own run in the
 * thinking bubble, so counting it would leave the dot lit for the very thread
 * the reader is looking at.
 */
export const hasOtherRunningConversation = (
  conversations: readonly { id: string; activeRun: unknown }[],
  activeThreadId: string | null,
): boolean =>
  conversations.some(
    (conversation) => conversation.activeRun !== null && conversation.id !== activeThreadId,
  )

/**
 * The dot over the whole set: any agent the rail is offering has a conversation
 * running somewhere the reader is not. Entries for agents no longer in the set
 * are ignored rather than cleared, so a rail that has just narrowed cannot keep
 * a dot lit for an agent it no longer names.
 */
export const anyConversationRunning = (
  runningByAgentId: Readonly<Record<string, boolean>>,
  agents: readonly AgentRecord[],
): boolean => agents.some((agent) => runningByAgentId[agent.id] === true)
