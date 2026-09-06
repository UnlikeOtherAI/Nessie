import { useMemo, useState } from 'react'
import type { FeedItem } from './channel-feed'

// The date-collapse bookkeeping for the message feed: which date separators
// are collapsed, and the filtered item list that skips whatever falls under a
// collapsed one. Pure state + derivation, no JSX — the feed itself owns the
// date-pill rendering and the toggle button.
export const useCollapsedFeedDates = (feedItems: FeedItem[]) => {
  const [collapsedDateKeys, setCollapsedDateKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const visibleFeedItems = useMemo(() => {
    const visible: FeedItem[] = []
    let activeDateKey: string | null = null

    for (const item of feedItems) {
      if (item.kind === 'date') {
        activeDateKey = item.key
        visible.push(item)
        continue
      }

      if (!activeDateKey || !collapsedDateKeys.has(activeDateKey)) {
        visible.push(item)
      }
    }

    return visible
  }, [collapsedDateKeys, feedItems])
  const toggleDateKey = (dateKey: string) => {
    setCollapsedDateKeys((current) => {
      const next = new Set(current)
      if (next.has(dateKey)) {
        next.delete(dateKey)
      } else {
        next.add(dateKey)
      }
      return next
    })
  }

  return { collapsedDateKeys, toggleDateKey, visibleFeedItems }
}
