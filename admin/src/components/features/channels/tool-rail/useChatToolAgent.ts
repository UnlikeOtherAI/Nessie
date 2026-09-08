import { useCallback, useMemo, useState } from 'react'

import type { AgentRecord } from '../../../../lib/api-client'
import {
  readChatToolAgentId,
  selectedChatToolAgent,
  writeChatToolAgentId,
} from './chat-tools'

export type ChatToolAgentState = {
  /** Whose conversations the column shows; `null` only when the set is empty. */
  selectedAgent: AgentRecord | null
  selectAgent: (agentId: string) => void
}

/**
 * Which of a room's agents the conversations column is about, remembered per
 * room between visits.
 *
 * The choice is held with the room it was made for rather than beside it, for
 * the reason `useChatToolRail` holds the open tool with its agent: a room
 * switch would otherwise paint one frame of the previous room's choice — long
 * enough to mount the column and fire its list query against the wrong agent —
 * before a passive effect corrected it.
 *
 * A stored id that no longer names an agent in this room (unbound between two
 * visits, or hand-edited) falls back to the first bound agent rather than to an
 * empty column; `selectedChatToolAgent` owns that rule so the hook and its
 * tests read the same one.
 */
export const useChatToolAgent = (
  channelId: string | null,
  agents: readonly AgentRecord[],
): ChatToolAgentState => {
  const [selection, setSelection] = useState<{ agentId: string | null; channelId: string | null }>(
    () => ({ agentId: readChatToolAgentId(channelId), channelId }),
  )

  // Re-keyed during render rather than in an effect, and only when the room
  // genuinely changes. React re-runs this render before painting, so the
  // condition settles at once.
  if (channelId !== null && selection.channelId !== channelId) {
    setSelection({ agentId: readChatToolAgentId(channelId), channelId })
  }

  const storedAgentId = selection.channelId === channelId ? selection.agentId : null
  const selectedAgent = useMemo(
    () => selectedChatToolAgent(agents, storedAgentId),
    [agents, storedAgentId],
  )

  // The storage write sits beside `setState`, never inside its updater: an
  // updater must be pure, and a discarded concurrent render would otherwise
  // leave the stored preference disagreeing with what is on screen.
  const selectAgent = useCallback((agentId: string) => {
    writeChatToolAgentId(channelId, agentId)
    setSelection({ agentId, channelId })
  }, [channelId])

  // A stable object: callers put these in effect dependency arrays.
  return useMemo(() => ({ selectAgent, selectedAgent }), [selectAgent, selectedAgent])
}
