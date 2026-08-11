import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * How far above the last row still counts as "reading the newest message". A
 * few pixels of slack keeps sub-pixel rounding and momentum scrolling from
 * silently unpinning a reader who is sitting at the bottom.
 */
const NEAR_BOTTOM_PX = 80

/**
 * Keeps a scroll container pinned to the bottom of its content.
 *
 * Assigning `scrollTop = scrollHeight` once per render is not enough for a
 * message feed: rows keep growing after that layout pass — avatars and
 * attachment thumbnails decode, web fonts swap, markdown and code blocks
 * reflow, thinking bubbles tick — so the feed settles a screenful short and the
 * newest message ends up hidden behind the composer. Observing the content
 * instead re-pins on every height change, and stops as soon as the reader
 * scrolls up themselves.
 *
 * Attach `containerRef` to the scrolling element and `contentRef` to a single
 * wrapper around everything inside it. Both are callback refs, so a feed that
 * mounts its scroller later (the reply panel waits for its root message) still
 * gets observed the moment the element appears.
 */
export const useStickToBottom = (resetKey?: string | null) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  const scrollToBottom = useCallback(() => {
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [container])

  /** Hand control back to the reader — used when jumping to an older message. */
  const releasePin = useCallback(() => {
    pinnedRef.current = false
  }, [])

  /** Follow the bottom again — sending a message always jumps to your own post. */
  const pinToBottom = useCallback(() => {
    pinnedRef.current = true
    scrollToBottom()
  }, [scrollToBottom])

  // Opening a different conversation (or tab) always lands on its newest
  // message, even if the reader had scrolled up in the previous one.
  useLayoutEffect(() => {
    pinnedRef.current = true
    scrollToBottom()
  }, [resetKey, scrollToBottom])

  useEffect(() => {
    if (!container || !content) {
      return
    }

    const onScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      pinnedRef.current = distanceFromBottom <= NEAR_BOTTOM_PX
    }
    container.addEventListener('scroll', onScroll, { passive: true })

    // Content height covers new/edited rows and late-loading media; container
    // height covers window resizes and the composer growing with attachments.
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        scrollToBottom()
      }
    })
    observer.observe(content)
    observer.observe(container)

    return () => {
      container.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [container, content, scrollToBottom])

  return {
    containerRef: setContainer,
    contentRef: setContent,
    pinToBottom,
    releasePin,
  }
}
