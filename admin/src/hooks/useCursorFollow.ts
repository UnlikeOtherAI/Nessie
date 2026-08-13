import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * How far the ideal scroll position may drift before the container is moved.
 * Recentring on every committed frame would make a paragraph of arriving text
 * crawl the viewport upward pixel by pixel; a deadzone lets the line sit still
 * while it is written and only slides when it has genuinely moved off centre.
 */
const DEADZONE_PX = 24

/**
 * Above this the move is a jump rather than drift — an edit landing in another
 * part of the document — and is animated so the reader can see where they were
 * taken. Below it the correction is instant, because a smooth-scrolled 30px
 * every few frames reads as a wobble.
 */
const SMOOTH_JUMP_PX = 160

export type CursorFollow = {
  /**
   * The block holding the cursor. Used when no marker could be placed (the
   * cursor is inside fenced code, where inline text is never re-rendered), so
   * following degrades to the block instead of stopping.
   */
  blockRef: (node: HTMLElement | null) => void
  containerRef: (node: HTMLDivElement | null) => void
  /** A wrapper around everything inside the container, observed for reflow. */
  contentRef: (node: HTMLElement | null) => void
  following: boolean
  markerRef: (node: HTMLElement | null) => void
  refollow: () => void
}

type CursorFollowOptions = {
  /** Only a document still being written is followed. */
  active: boolean
  /** Changes once per committed frame; what re-runs the centring. */
  content: string
  /** A new value means a new edit began: re-engage and jump to it. */
  jumpKey: number
  /** Opening a different document starts followed again. */
  resetKey?: string | null
}

/**
 * Keeps the point an agent is writing at in the middle of a scroll container.
 *
 * The target is always the marker's centre at 50% of the container height,
 * **clamped to `[0, scrollHeight - clientHeight]`**. The clamp is the whole
 * trick at the two ends: while the document is short, or while the cursor is in
 * the last screenful, the clamp pins the scroll and the text simply grows into
 * the space below — no spacer element, no trailing white space, and at the end
 * of a document it behaves exactly like sticking to the bottom. In the middle
 * of a long document the clamp never binds and the cursor stays centred.
 *
 * Following is released by any sign the reader took over — wheel, touch drag,
 * a key, a grab of the scrollbar. Deliberately *not* by reading scroll position
 * the way `useStickToBottom` does: this hook scrolls the same container itself,
 * sometimes smoothly over many frames, so its own scroll events are
 * indistinguishable from a reader's and would unpin it instantly.
 */
export const useCursorFollow = ({
  active,
  content,
  jumpKey,
  resetKey,
}: CursorFollowOptions): CursorFollow => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [contentNode, setContentNode] = useState<HTMLElement | null>(null)
  const markerNodeRef = useRef<HTMLElement | null>(null)
  const blockNodeRef = useRef<HTMLElement | null>(null)
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)

  const engageFollow = useCallback((next: boolean) => {
    followingRef.current = next
    setFollowing(next)
  }, [])

  const markerRef = useCallback((node: HTMLElement | null) => {
    markerNodeRef.current = node
  }, [])

  const blockRef = useCallback((node: HTMLElement | null) => {
    blockNodeRef.current = node
  }, [])

  const centreOnCursor = useCallback(
    (force: boolean) => {
      const anchor = markerNodeRef.current ?? blockNodeRef.current
      if (!container || !anchor) {
        return
      }

      const containerBox = container.getBoundingClientRect()
      const anchorBox = anchor.getBoundingClientRect()
      // An empty inline marker can report a zero-height rect; its top is still
      // the line it sits on, and half a line is well inside the deadzone.
      const anchorCentre =
        anchorBox.top - containerBox.top + container.scrollTop + anchorBox.height / 2
      const limit = Math.max(0, container.scrollHeight - container.clientHeight)
      const target = Math.min(
        Math.max(anchorCentre - container.clientHeight / 2, 0),
        limit,
      )
      const drift = Math.abs(target - container.scrollTop)

      if (!force && drift <= DEADZONE_PX) {
        return
      }
      container.scrollTo({
        behavior: drift > SMOOTH_JUMP_PX ? 'smooth' : 'auto',
        top: target,
      })
    },
    [container],
  )

  // Every committed frame: keep the cursor centred, within the deadzone.
  useLayoutEffect(() => {
    if (!active || !followingRef.current) {
      return
    }
    centreOnCursor(false)
  }, [active, centreOnCursor, content])

  // A new edit is a move the reader asked to see, so it re-engages following
  // even after they scrolled away, and ignores the deadzone.
  useLayoutEffect(() => {
    if (!active) {
      return
    }
    engageFollow(true)
    centreOnCursor(true)
  }, [active, centreOnCursor, jumpKey, engageFollow])

  // A different document starts followed, however the previous one was left.
  useLayoutEffect(() => {
    engageFollow(true)
  }, [resetKey, engageFollow])

  // Late reflow — fonts swapping, a code block wrapping — moves the cursor
  // without any new text arriving.
  useEffect(() => {
    if (!container || !contentNode) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (active && followingRef.current) {
        centreOnCursor(false)
      }
    })
    observer.observe(contentNode)
    observer.observe(container)
    return () => observer.disconnect()
  }, [active, centreOnCursor, container, contentNode])

  useEffect(() => {
    if (!container) {
      return
    }
    const release = () => {
      if (followingRef.current) {
        engageFollow(false)
      }
    }
    container.addEventListener('wheel', release, { passive: true })
    container.addEventListener('touchmove', release, { passive: true })
    container.addEventListener('mousedown', release)
    container.addEventListener('keydown', release)
    return () => {
      container.removeEventListener('wheel', release)
      container.removeEventListener('touchmove', release)
      container.removeEventListener('mousedown', release)
      container.removeEventListener('keydown', release)
    }
  }, [container, engageFollow])

  const refollow = useCallback(() => {
    engageFollow(true)
    centreOnCursor(true)
  }, [centreOnCursor, engageFollow])

  return {
    blockRef,
    containerRef: setContainer,
    contentRef: setContentNode,
    following,
    markerRef,
    refollow,
  }
}
