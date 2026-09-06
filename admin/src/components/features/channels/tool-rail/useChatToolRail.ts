import { useCallback, useMemo, useState } from 'react'

import {
  readOpenChatTool,
  writeOpenChatTool,
  type ChatToolId,
} from './chat-tools'

export type ChatToolRailState = {
  openTool: ChatToolId | null
  /** An explicit close: forgets the preference too. */
  close: () => void
  /** Opens without toggling — what a list row needs, which has no pressed state. */
  open: (tool: ChatToolId) => void
  toggle: (tool: ChatToolId) => void
}

type Selection = {
  /** Which agent this choice belongs to; `null` before one has resolved. */
  agentId: string | null
  tool: ChatToolId | null
}

type ChatToolRailOptions = {
  /**
   * Whether the choice outlives the visit. False on a single-column layout,
   * where the column is a full screen: restoring it there would put a browser
   * page over the conversation every time somebody returned to the agent,
   * which is a modal interstitial, not a remembered layout.
   */
  remember: boolean
}

/**
 * Which tool column is open for this agent, remembered between visits.
 *
 * The choice is held with the agent it was made for rather than beside it. A
 * conversation switch would otherwise paint one frame of the previous agent's
 * tool — long enough to mount the column and fire its queries against the new
 * agent — before a passive effect corrected it.
 */
export const useChatToolRail = (
  agentId: string | null,
  { remember }: ChatToolRailOptions,
): ChatToolRailState => {
  const [selection, setSelection] = useState<Selection>(() => ({
    agentId,
    tool: remember ? readOpenChatTool(agentId) : null,
  }))

  // Re-keyed during render rather than in an effect, and only when the agent
  // genuinely changes. An effect would paint one frame of the previous
  // agent's tool first — long enough to mount the column and fire its queries
  // against the new agent. And because the last agent stays recorded, a flap
  // to `null` while the participants query refetches is not a switch: the tool
  // is still there when the agent comes back, which on a layout that does not
  // remember (a phone) is the difference between working and not. React
  // re-runs this render before painting, so the condition settles at once.
  if (agentId !== null && selection.agentId !== agentId) {
    setSelection({ agentId, tool: remember ? readOpenChatTool(agentId) : null })
  }

  const openTool = selection.agentId === agentId ? selection.tool : null

  // The storage write sits beside `setState`, never inside its updater: an
  // updater must be pure, and a discarded concurrent render would otherwise
  // leave the stored preference disagreeing with what is on screen.
  const commit = useCallback((tool: ChatToolId | null) => {
    if (remember) writeOpenChatTool(agentId, tool)
    setSelection({ agentId, tool })
  }, [agentId, remember])

  const close = useCallback(() => commit(null), [commit])
  const open = useCallback((tool: ChatToolId) => commit(tool), [commit])
  const toggle = useCallback(
    (tool: ChatToolId) => commit(openTool === tool ? null : tool),
    [commit, openTool],
  )

  // A stable object: callers put these in effect dependency arrays.
  return useMemo(
    () => ({ close, open, openTool, toggle }),
    [close, open, openTool, toggle],
  )
}
