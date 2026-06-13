import { useCallback, useEffect, useMemo, useState } from 'react'
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

  const toggleStar = useCallback((type: PreferenceStarredItem['type'], id: string) => {
    setStarred((prev) => {
      const exists = prev.some((s) => s.type === type && s.id === id)
      const next = exists
        ? prev.filter((s) => !(s.type === type && s.id === id))
        : [...prev, { type, id }]
      updatePreferences.mutate({ starred: next })
      return next
    })
  }, [updatePreferences])

  return {
    channelsCollapsed,
    dmCollapsed,
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
