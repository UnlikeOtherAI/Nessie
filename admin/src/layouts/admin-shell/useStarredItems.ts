import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUpdatePreferences } from '../../facades/auth/hooks'
import { getCookie, setCookie } from '../../lib/storage'
import type { PreferenceStarredItem } from './types'

type UseStarredItemsArgs = {
  initialStarred: PreferenceStarredItem[]
}

/**
 * Owns the cookie-backed sidebar collapse state plus the starred-item list,
 * including persistence to the user preferences endpoint.
 */
export const useStarredItems = ({ initialStarred }: UseStarredItemsArgs) => {
  const updatePreferences = useUpdatePreferences()
  const [channelsCollapsed, setChannelsCollapsed] = useState(
    () => getCookie('channelsCollapsed') === '1',
  )
  const [projectsCollapsed, setProjectsCollapsed] = useState(
    () => getCookie('projectsCollapsed') === '1',
  )
  const [starredCollapsed, setStarredCollapsed] = useState(
    () => getCookie('starredCollapsed') === '1',
  )
  const [dmCollapsed, setDmCollapsed] = useState(() => getCookie('dmCollapsed') === '1')
  const [starred, setStarred] = useState<PreferenceStarredItem[]>(() => initialStarred)
  // The list the reader is looking at, readable from a callback without
  // making that callback's identity depend on it.
  const starredRef = useRef(starred)
  starredRef.current = starred
  // How many preference writes this device has in flight. A `me` that was
  // produced before the newest of them still carries the pre-toggle list, and
  // adopting it would visibly un-star what the reader just starred.
  const pendingStarredWrites = useRef(0)

  // Expanding is its own verb, not a toggle with a guard at every call site.
  // Something new landing in a closed section has to open it — a channel
  // nobody can see is not a channel that was created — and that must never
  // close a section that was already open.
  const expandChannels = useCallback(() => {
    setChannelsCollapsed((prev) => {
      if (!prev) return prev
      setCookie('channelsCollapsed', '0')
      return false
    })
  }, [])

  const expandProjects = useCallback(() => {
    setProjectsCollapsed((prev) => {
      if (!prev) return prev
      setCookie('projectsCollapsed', '0')
      return false
    })
  }, [])

  const toggleChannelsCollapsed = useCallback(() => {
    setChannelsCollapsed((prev) => {
      const next = !prev
      setCookie('channelsCollapsed', next ? '1' : '0')
      return next
    })
  }, [])

  const toggleProjectsCollapsed = useCallback(() => {
    setProjectsCollapsed((prev) => {
      const next = !prev
      setCookie('projectsCollapsed', next ? '1' : '0')
      return next
    })
  }, [])

  const toggleStarredCollapsed = useCallback(() => {
    setStarredCollapsed((prev) => {
      const next = !prev
      setCookie('starredCollapsed', next ? '1' : '0')
      return next
    })
  }, [])

  const toggleDmCollapsed = useCallback(() => {
    setDmCollapsed((prev) => {
      const next = !prev
      setCookie('dmCollapsed', next ? '1' : '0')
      return next
    })
  }, [])

  useEffect(() => {
    if (pendingStarredWrites.current > 0) return
    setStarred(initialStarred)
  }, [initialStarred])

  const starredChannelIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'channel').map((item) => item.id)),
    [starred],
  )
  const starredProjectIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'project').map((item) => item.id)),
    [starred],
  )
  const starredUserIds = useMemo(
    () => new Set(starred.filter((item) => item.type === 'user').map((item) => item.id)),
    [starred],
  )

  // The star lights up immediately and the write follows; a failed write puts
  // the list back exactly as it was, so the sidebar never keeps a star the
  // server refused.
  const toggleStar = useCallback((type: PreferenceStarredItem['type'], id: string) => {
    const previous = starredRef.current
    const exists = previous.some((item) => item.type === type && item.id === id)
    const next = exists
      ? previous.filter((item) => !(item.type === type && item.id === id))
      : [...previous, { type, id }]
    starredRef.current = next
    setStarred(next)
    pendingStarredWrites.current += 1
    updatePreferences.mutate({ starred: next }, {
      onError: () => {
        starredRef.current = previous
        setStarred(previous)
      },
      onSettled: () => {
        pendingStarredWrites.current -= 1
      },
    })
  }, [updatePreferences])

  return {
    channelsCollapsed,
    dmCollapsed,
    expandChannels,
    expandProjects,
    projectsCollapsed,
    starred,
    starredChannelIds,
    starredCollapsed,
    starredProjectIds,
    starredUserIds,
    toggleChannelsCollapsed,
    toggleDmCollapsed,
    toggleProjectsCollapsed,
    toggleStar,
    toggleStarredCollapsed,
  }
}
