import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  readOpenChatTool,
  writeOpenChatTool,
  type ChatToolId,
} from './chat-tools'

export type ChatToolRailState = {
  openTool: ChatToolId | null
  close: () => void
  toggle: (tool: ChatToolId) => void
}

/**
 * Which tool column is open for this agent, remembered between visits.
 *
 * The selection is keyed by agent and re-read whenever the conversation
 * changes, so walking from one agent to another shows each one's own rail
 * rather than carrying the last agent's choice across.
 */
export const useChatToolRail = (agentId: string | null): ChatToolRailState => {
  const [openTool, setOpenTool] = useState<ChatToolId | null>(() => readOpenChatTool(agentId))

  // Switching agents is a different rail, not a re-render of this one.
  useEffect(() => {
    setOpenTool(readOpenChatTool(agentId))
  }, [agentId])

  const close = useCallback(() => {
    setOpenTool(null)
    writeOpenChatTool(agentId, null)
  }, [agentId])

  const toggle = useCallback((tool: ChatToolId) => {
    setOpenTool((current) => {
      const next = current === tool ? null : tool
      writeOpenChatTool(agentId, next)
      return next
    })
  }, [agentId])

  // A stable object: callers put `close` in effect dependency arrays, and a
  // fresh literal every render would re-run them every render.
  return useMemo(() => ({ close, openTool, toggle }), [close, openTool, toggle])
}
