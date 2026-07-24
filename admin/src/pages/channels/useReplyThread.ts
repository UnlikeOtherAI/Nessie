import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  useSetMessageThreadFollow,
  useThreadMessage,
  useThreadReplies,
} from '../../facades/threads/hooks'
import {
  readThreadPanelWidth,
  clampThreadPanelWidth,
  THREAD_PANEL_WIDTH_STORAGE_KEY,
  type ThreadParticipant,
} from '../../components/features/channels/thread-panel/thread-panel-helpers'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../lib/api-client'

interface UseReplyThreadParams {
  activeChannel: ChannelRecord | null
  agents: AgentRecord[]
  channelUsers: UserRecord[]
}

// Owns the reply-thread panel state (#233): the open root message lives in the
// URL (/channels/:channelId/threads/:threadId/replies/:rootMessageId) so the
// panel is deep-linkable and browser Back closes it, plus the drag-resizable
// panel width persisted to localStorage.
export const useReplyThread = ({
  activeChannel,
  agents,
  channelUsers,
}: UseReplyThreadParams) => {
  const navigate = useNavigate()
  const { channelId, threadId, rootMessageId } = useParams()
  // The route carries the container thread; on plain channel routes the
  // channel's default thread is the container.
  const activeThreadId = threadId ?? activeChannel?.defaultThreadId
  const openRootMessageId = rootMessageId ?? null

  const openThread = useCallback(
    (rootId: string) => {
      if (!channelId || !activeThreadId) {
        return
      }
      navigate(`/channels/${channelId}/threads/${activeThreadId}/replies/${rootId}`)
    },
    [activeThreadId, channelId, navigate],
  )

  const closeThread = useCallback(() => {
    if (!channelId) {
      return
    }
    navigate(`/channels/${channelId}`)
  }, [channelId, navigate])

  const [panelWidth, setPanelWidth] = useState(() =>
    readThreadPanelWidth(
      window.localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY),
      window.innerWidth,
    ),
  )
  const resizePanel = useCallback((next: number) => {
    const clamped = clampThreadPanelWidth(next, window.innerWidth)
    setPanelWidth(clamped)
    window.localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(clamped))
  }, [])

  const rootQuery = useThreadMessage(activeThreadId, openRootMessageId ?? undefined)
  const repliesQuery = useThreadReplies(activeThreadId, openRootMessageId ?? undefined)
  const followMutation = useSetMessageThreadFollow(
    activeThreadId,
    openRootMessageId ?? undefined,
  )

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const userMap = useMemo(
    () => new Map(channelUsers.map((user) => [user.id, user])),
    [channelUsers],
  )
  // Summary-bar participants are user or agent ids; resolve both so the
  // overlapping avatars can mix people and agents.
  const resolveThreadParticipant = useCallback(
    (participantId: string): ThreadParticipant | null => {
      const user = userMap.get(participantId)
      if (user) {
        return {
          kind: 'user',
          avatarAttachmentId: user.avatarAttachmentId,
          avatarUrl: user.avatarUrl,
          displayName: user.displayName,
          gravatarUrl: user.gravatarUrl,
        }
      }
      const agent = agentMap.get(participantId)
      return agent ? { kind: 'agent', agent } : null
    },
    [agentMap, userMap],
  )

  return {
    activeThreadId,
    closeThread,
    followMutation,
    openRootMessageId,
    openThread,
    panelWidth,
    repliesQuery,
    resizePanel,
    resolveThreadParticipant,
    rootQuery,
  }
}
