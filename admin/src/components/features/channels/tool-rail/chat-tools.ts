/**
 * The tools a conversation with one agent puts within reach.
 *
 * The rail beside the chat, the conversation header on a single-column layout
 * and the conversation info screen's list all read this table, so the doorways
 * cannot drift apart. It is not the whole of adding a tool: a new entry also
 * needs its mark in `ChatToolRail` and the column it opens in `ChatToolDock`.
 */

import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'

export const CHAT_TOOL_IDS = ['browser'] as const

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
}

export const CHAT_TOOLS: readonly ChatTool[] = [
  {
    description: 'Its own browser — watch it work, or pick up where it left off.',
    id: 'browser',
    label: 'Browser',
  },
]

/** Which control carries the tools on a given layout. */
export type ChatToolDoorway = 'header' | 'none' | 'rail'

/**
 * Where a conversation's agent tools are reachable from.
 *
 * The rail and the conversation header are complements, never alternatives:
 * whichever one is not carrying the tools draws nothing, so a tool is offered
 * exactly once — and never, as it was on the iOS phone app, nowhere. There the
 * rail correctly stands down on a single-column layout, and the only doorway
 * left was a row on the conversation info screen: two screens in, behind the
 * native bar's `···` sheet, which is not a place anybody finds a browser.
 */
export const chatToolDoorway = ({
  hasConversationAgent,
  single,
}: {
  hasConversationAgent: boolean
  single: boolean
}): ChatToolDoorway => {
  if (!hasConversationAgent) return 'none'
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
  hasConversationAgent,
  onOpenTool,
  single,
}: {
  hasConversationAgent: boolean
  onOpenTool: (tool: ChatToolId) => void
  single: boolean
}): PageHeaderAction[] =>
  chatToolDoorway({ hasConversationAgent, single }) === 'header'
    ? CHAT_TOOLS.map((tool) => ({
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
