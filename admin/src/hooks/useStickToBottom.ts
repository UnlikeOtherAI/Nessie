import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * How far above the last row still counts as "reading the newest message". A
 * few pixels of slack keeps sub-pixel rounding and momentum scrolling from
 * silently unpinning a reader who is sitting at the bottom.
 */
const NEAR_BOTTOM_PX = 80

/** Start the next history read just before the reader reaches the first row. */
export const HISTORY_TOP_THRESHOLD_PX = 160

export type OlderContentLoader = {
  failed: boolean
  hasMore: boolean
  isLoading: boolean
  itemCount: number
  loadMore: () => Promise<unknown>
  pageCount: number
}

type PrependSnapshot = {
  anchor: HTMLElement | null
  anchorId: string | null
  anchorTop: number
  itemCount: number
  pageCount: number
  scrollHeight: number
  scrollTop: number
}

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
 *
 * `follow` is what a shared scroller needs: a channel's Messages section reads
 * newest-last and belongs at the bottom, while its Agent or To-dos section is a
 * document and belongs at the top. Passing false lands at the top and keeps it
 * there, so a long tool list no longer opens scrolled to its final row.
 */
export const useStickToBottom = (
  resetKey?: string | null,
  follow = true,
  olderContent?: OlderContentLoader,
) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const olderContentRef = useRef(olderContent)
  const prependSnapshotRef = useRef<PrependSnapshot | null>(null)
  olderContentRef.current = olderContent

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

  /**
   * Fetch one older page from a top-edge gesture. The first existing message is
   * captured as the visual anchor; once rows prepend, the layout effect below
   * restores that exact row to the same screen position.
   */
  const loadOlder = useCallback(() => {
    const loader = olderContentRef.current
    if (
      !container
      || !loader?.hasMore
      || loader.isLoading
      || prependSnapshotRef.current
    ) {
      return
    }

    const anchor = content?.querySelector<HTMLElement>('[data-message-id]') ?? null
    const containerTop = container.getBoundingClientRect().top
    prependSnapshotRef.current = {
      anchor,
      anchorId: anchor?.dataset.messageId ?? null,
      anchorTop: anchor ? anchor.getBoundingClientRect().top - containerTop : 0,
      itemCount: loader.itemCount,
      pageCount: loader.pageCount,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    }
    void loader.loadMore().catch(() => {
      prependSnapshotRef.current = null
    })
  }, [container, content])

  // Opening a different conversation (or tab) always lands where that section
  // starts — the newest message for a feed, the first line for a document —
  // even if the reader had scrolled in the previous one.
  useLayoutEffect(() => {
    prependSnapshotRef.current = null
    pinnedRef.current = follow
    if (follow) scrollToBottom()
    else if (container) container.scrollTop = 0
  }, [container, follow, resetKey, scrollToBottom])

  // Prepending changes scrollHeight above the reader. Restore the same message
  // to the same visual offset before the browser paints, so history loads do
  // not make the conversation jump. An anchor survives unrelated changes at
  // the bottom; the height delta is the fallback when there was no message row.
  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current
    if (!container || !snapshot || olderContent?.isLoading) return
    if (olderContent?.failed) {
      prependSnapshotRef.current = null
      return
    }

    // Query observers can briefly report `isLoading: false` before their
    // derived row list reflects the page that just arrived. Settling against
    // that intermediate render includes the disappearing loading row in the
    // height delta and leaves the reader one status-row too high. A changed
    // page count is the durable proof that the prepend is in this render.
    // Field reads, never the loader object: the effect's dependency list is
    // the individual fields, and `olderContent` is rebuilt by the caller on
    // every render. `-1` stands for "no loader", which never counts as arrived.
    const pageArrived = (olderContent?.pageCount ?? -1) > snapshot.pageCount
    if (!pageArrived && olderContent?.hasMore) return

    let addedHeight = container.scrollHeight - snapshot.scrollHeight
    const currentAnchor = snapshot.anchor?.isConnected
      ? snapshot.anchor
      : [...(content?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])]
        .find((entry) => entry.dataset.messageId === snapshot.anchorId) ?? null
    if (currentAnchor) {
      const nextAnchorTop =
        currentAnchor.getBoundingClientRect().top - container.getBoundingClientRect().top
      addedHeight = nextAnchorTop - snapshot.anchorTop
    }
    if ((olderContent?.itemCount ?? -1) > snapshot.itemCount) {
      container.scrollTop = snapshot.scrollTop + Math.max(0, addedHeight)
    }
    prependSnapshotRef.current = null

    // A filtered chat drawer can receive a page with no matching rows. Continue
    // the one explicit top-edge read until it finds visible history or reaches
    // the beginning, instead of leaving the reader stuck at an inert top edge.
    if (
      olderContent?.hasMore
      && pageArrived
      && addedHeight <= 0
      && container.scrollTop <= HISTORY_TOP_THRESHOLD_PX
    ) {
      queueMicrotask(loadOlder)
    }
  }, [
    container,
    content,
    loadOlder,
    olderContent?.failed,
    olderContent?.hasMore,
    olderContent?.isLoading,
    olderContent?.itemCount,
    olderContent?.pageCount,
  ])

  useEffect(() => {
    if (!container || !content) {
      return
    }

    const onScroll = () => {
      if (!follow) return
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      pinnedRef.current = distanceFromBottom <= NEAR_BOTTOM_PX
      if (
        container.scrollTop <= HISTORY_TOP_THRESHOLD_PX
        && !olderContentRef.current?.failed
      ) {
        loadOlder()
      }
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
  }, [container, content, follow, loadOlder, scrollToBottom])

  // If a page is too short to overflow the viewport, there is no scroll event
  // to reach the top. Fill it from older history until it can scroll (or the
  // server says there is no earlier page).
  useEffect(() => {
    if (
      follow
      && container
      && olderContent?.hasMore
      && !olderContent.failed
      && !olderContent.isLoading
      && container.scrollTop <= HISTORY_TOP_THRESHOLD_PX
      && container.scrollHeight <= container.clientHeight
    ) {
      loadOlder()
    }
  }, [
    container,
    follow,
    loadOlder,
    olderContent?.failed,
    olderContent?.hasMore,
    olderContent?.isLoading,
    olderContent?.itemCount,
  ])

  return {
    containerRef: setContainer,
    contentRef: setContent,
    loadOlder,
    pinToBottom,
    releasePin,
  }
}
