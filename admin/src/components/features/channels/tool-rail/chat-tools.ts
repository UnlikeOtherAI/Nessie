/**
 * The tools a conversation with one agent puts within reach.
 *
 * The rail beside the chat and any future phone list both read this table, so
 * a tool is added in one place and appears in every doorway (Rule zero, check
 * 4). Today it holds one entry — the agent's cloud browser — and the shape is
 * deliberately the smallest thing that can carry a second: an id, what the
 * control says, and the sentence that says which question it answers.
 */

export const CHAT_TOOL_IDS = ['browser'] as const

export type ChatToolId = (typeof CHAT_TOOL_IDS)[number]

export type ChatTool = {
  id: ChatToolId
  label: string
  /**
   * What opening it answers. Rule zero check 3: a rail button that cannot say
   * which question it settles is decoration, so every row carries this and the
   * rail renders it as the control's title.
   */
  description: string
}

export const CHAT_TOOLS: readonly ChatTool[] = [
  {
    description: 'Watch the browser this agent drives, or take the keyboard.',
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
