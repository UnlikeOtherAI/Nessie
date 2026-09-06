import { useEffect, useMemo } from 'react'

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
import type { ChatToolRailState } from './useChatToolRail'

type ChatToolDockProps = {
  /** The one agent this conversation is with; the rail is per agent. */
  agent: AgentRecord
  /**
   * A reply thread or a presented dashboard already holds the right-hand
   * column. Below `xl` there is only one of those to hold.
   */
  otherPanelOpen: boolean
  rail: ChatToolRailState
  threadId: string | null
}

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
  otherPanelOpen,
  rail,
  threadId,
}: ChatToolDockProps) => {
  const single = useNavigationLayout() === 'single'
  const { atLeast } = useViewport()
  // Panels only stand side by side from `xl` up; below it every one of them is
  // a layer over the conversation, and two layers at the same right edge is
  // two scrims and a covered panel. So narrower than that, the newest arrival
  // wins and the tool closes — which is what the rail must then show, rather
  // than staying lit over a column nobody can see.
  const crowdedOut = otherPanelOpen && !atLeast.xl
  const browserOpen = rail.openTool === 'browser' && !crowdedOut

  const { close } = rail
  useEffect(() => {
    if (crowdedOut) close()
  }, [close, crowdedOut])
  // Watching wants a fresh answer; a rail dot does not. Both callers share one
  // query key, so a conversation with the column open polls once, quickly.
  const sessions = useThreadBrowserSessions(threadId, {
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
        <AgentScreenPanel agent={agent} onClose={rail.close} sessionId={liveSessionId} />
      ) : null}
      {single ? null : (
        <ChatToolRail
          liveTools={liveTools}
          onToggle={rail.toggle}
          openTool={rail.openTool}
        />
      )}
    </>
  )
}
