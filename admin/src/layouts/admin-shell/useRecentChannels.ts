import { useEffect, useState } from 'react'

// Recently-opened channels, persisted to localStorage so the top bar's history
// button can offer a quick jump list (Slack's clock menu). Kept tiny on purpose:
// a capped, deduped list of {id,label}, no server round-trip.
export type RecentChannel = { id: string; label: string }

const STORAGE_KEY = 'nessie.recentChannels'
const MAX_RECENTS = 8
const CHANGE_EVENT = 'nessie:recent-channels'

const read = (): RecentChannel[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is RecentChannel =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentChannel).id === 'string' &&
        typeof (entry as RecentChannel).label === 'string',
    )
  } catch {
    return []
  }
}

export const recordRecentChannel = (channel: RecentChannel): void => {
  const next = [channel, ...read().filter((entry) => entry.id !== channel.id)].slice(0, MAX_RECENTS)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // Notify same-tab listeners (the native `storage` event only fires cross-tab).
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    // Storage disabled or over quota — recents are best-effort, so ignore.
  }
}

export const useRecentChannels = (): RecentChannel[] => {
  const [recents, setRecents] = useState<RecentChannel[]>(read)

  useEffect(() => {
    const refresh = () => setRecents(read())
    window.addEventListener(CHANGE_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return recents
}
