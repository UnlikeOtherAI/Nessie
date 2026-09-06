import { useMemo } from 'react'

import type { AgentRecord } from '../../../../lib/api-client'
import {
  RAIL_POLL_MS,
  WATCHING_POLL_MS,
  useThreadBrowserSessions,
} from '../../../../facades/browser-cloud/hooks'
import { useViewport } from '../../../../hooks/useViewport'
import { useNavigationLayout } from '../../../../navigation/mobile-shell'
import { AgentScreenPanel } from '../../browser-cloud/AgentScreenPanel'
import { ChatToolRail } from './ChatToolRail'
import type { ChatToolId } from './chat-tools'

type ChatToolDockProps = {
  /** The one agent this conversation is with; the rail is per agent. */
  agent: AgentRecord
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
  'Close the thread to open a tool beside this conversation, or widen the window.'

/**
 * The tool rail and the column it opens, as two siblings of the conversation.
 *
 * They are ordinary flex children rather than a layer over the chat: on a wide
 * screen the row reads menu · conversation · reply thread · tool column · rail,
 * and every one of them keeps its own width. On a single-column layout the
 * rail is not drawn at all — its doorway is the conversation info screen — and
 * the column, which is `SidePanelShell`, becomes a full screen with its own
 * Back.
 */
export const ChatToolDock = ({
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
  // Two 400px panels plus the shell's own 389px of chrome leave a 1280px
  // window 91px of conversation, and below `xl` they are not columns at all —
  // each is a layer over the chat, so a second one means two scrims and a
  // covered panel. Narrower than `2xl`, then, a thread and a tool cannot both
  // stand: the rail says so and stays pressable the moment there is room. It
  // does *not* close the tool, because a window resize is not a decision and
  // must not erase what the reader chose.
  const crowded = otherPanelOpen && !atLeast['2xl'] && !routed
  const browserOpen = openTool === 'browser' && !crowded

  // Watching wants a fresh answer; a rail dot does not, and a layout with no
  // rail wants none at all. Both callers share one query key, so a
  // conversation with the column open polls once, quickly.
  const sessions = useThreadBrowserSessions(threadId, {
    enabled: browserOpen || !single,
    refetchInterval: browserOpen ? WATCHING_POLL_MS : RAIL_POLL_MS,
  })
  const liveSessionId = sessions.data?.sessions[0]?.id ?? null

  const liveTools = useMemo(
    () => new Set<ChatToolId>(liveSessionId === null ? [] : ['browser']),
    [liveSessionId],
  )

  return (
    <>
      {browserOpen ? (
        <AgentScreenPanel
          agent={agent}
          onClose={onClose}
          sessionId={liveSessionId}
          threadId={threadId}
        />
      ) : null}
      {single ? null : (
        <ChatToolRail
          blockedReason={crowded ? CROWDED_REASON : null}
          liveTools={liveTools}
          onToggle={onToggle}
          openTool={crowded ? null : openTool}
        />
      )}
    </>
  )
}
