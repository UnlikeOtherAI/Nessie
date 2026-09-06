/**
 * The tools a conversation with one agent puts within reach.
 *
 * The rail beside the chat and the conversation info screen's list both read
 * this table, so the two doorways cannot drift apart. It is not the whole of
 * adding a tool: a new entry also needs its mark in `ChatToolRail` and the
 * column it opens in `ChatToolDock`.
 */

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
    description: 'This agent’s own browser, and its screen while it browses.',
    id: 'browser',
    label: 'Browser',
  },
]

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
