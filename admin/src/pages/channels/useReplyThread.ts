import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  useThreadMessage,
  useThreadReplies,
} from '../../facades/threads/hooks'
import {
  readThreadPanelWidth,
  clampThreadPanelWidth,
  THREAD_PANEL_CLOSE_MS,
  THREAD_PANEL_WIDTH_STORAGE_KEY,
  type ThreadParticipant,
} from '../../components/features/channels/thread-panel/thread-panel-helpers'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../lib/api-client'
import { usePhoneLayout } from '../../lib/mobile-shell'
import { usePhoneNavigation } from '../../layouts/admin-shell/PhoneNavigationProvider'

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
  const phoneLayout = usePhoneLayout()
  const phoneNavigation = usePhoneNavigation()
  const { channelId, threadId, rootMessageId } = useParams()
  // The route carries the container thread; on plain channel routes the
  // channel's default thread is the container.
  const activeThreadId = threadId ?? activeChannel?.defaultThreadId
  const openRootMessageId = rootMessageId ?? null

  // The panel leaves before the route does. `isClosing` is what the panel
  // animates on, and the navigation is held until that finishes so the panel
  // still has a thread to render while it goes — its queries are keyed on the
  // open root, so navigating first would blank it mid-animation.
  const [isClosing, setIsClosing] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelPendingClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setIsClosing(false)
  }, [])

  useEffect(() => () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
    }
  }, [])

  // The route reached the channel, so whatever started the close is finished.
  // Resetting here rather than beside the navigate keeps the panel from
  // flashing back to full width for the frame before it unmounts.
  useEffect(() => {
    if (openRootMessageId === null) {
      setIsClosing(false)
    }
  }, [openRootMessageId])

  const openThread = useCallback(
    (rootId: string) => {
      if (!channelId || !activeThreadId) {
        return
      }
      // A reply control lives inside the conversation column, so clicking one
      // passes through the tap-outside handler on the way here. Opening always
      // wins over a close that same click just started.
      cancelPendingClose()
      navigate(`/channels/${channelId}/threads/${activeThreadId}/replies/${rootId}`)
    },
    [activeThreadId, cancelPendingClose, channelId, navigate],
  )

  const closeThread = useCallback(() => {
    if (phoneLayout && phoneNavigation) {
      phoneNavigation.performBack()
      return
    }
    if (!channelId || closeTimer.current !== null) {
      return
    }
    // Somebody who has asked for less motion gets no dead pause either.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate(`/channels/${channelId}`)
      return
    }
    setIsClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      navigate(`/channels/${channelId}`)
    }, THREAD_PANEL_CLOSE_MS)
  }, [channelId, navigate, phoneLayout, phoneNavigation])

  // Tapping back into the conversation column dismisses the thread, the way
  // the tablet scrim already does — at desktop widths the column is the only
  // "outside" there is. A click that ended a text selection is the person
  // reading, not leaving.
  const closeThreadFromConversation = useCallback(() => {
    if (!openRootMessageId) {
      return
    }
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) {
      return
    }
    closeThread()
  }, [closeThread, openRootMessageId])

  // Continuous drag geometry is on the plan's geometry allowlist
  // (docs/plans/2026-08-13-responsive-coherence.md §C.5): the 50vw maximum
  // moves continuously with the window, so the band store cannot carry it.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  // The stored value is the person's *preferred* width; the rendered width is
  // that preference derived against the current bounds, so a temporary
  // viewport shrink never destroys what they chose.
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readThreadPanelWidth(
      window.localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY),
      window.innerWidth,
    ),
  )
  const panelWidth = clampThreadPanelWidth(preferredWidth, viewportWidth)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Mid-gesture updates only move the preference; persistence happens once,
  // when the interaction ends (persistPanelWidth / resizePanelWithKeyboard).
  const resizePanel = useCallback((next: number) => {
    setPreferredWidth(clampThreadPanelWidth(next, window.innerWidth))
  }, [])

  const persistPanelWidth = useCallback(() => {
    setPreferredWidth((current) => {
      window.localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(current))
      return current
    })
  }, [])

  const resizePanelWithKeyboard = useCallback((next: number) => {
    const clamped = clampThreadPanelWidth(next, window.innerWidth)
    setPreferredWidth(clamped)
    window.localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(clamped))
  }, [])

  const rootQuery = useThreadMessage(activeThreadId, openRootMessageId ?? undefined)
  const repliesQuery = useThreadReplies(activeThreadId, openRootMessageId ?? undefined)

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
          userId: user.id,
          avatarAttachmentId: user.avatarAttachmentId,
          avatarUrl: user.avatarUrl,
          displayName: user.displayName,
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
    closeThreadFromConversation,
    isClosing,
    openRootMessageId,
    openThread,
    panelWidth,
    persistPanelWidth,
    repliesQuery,
    resizePanel,
    resizePanelWithKeyboard,
    resolveThreadParticipant,
    rootQuery,
    viewportWidth,
  }
}
