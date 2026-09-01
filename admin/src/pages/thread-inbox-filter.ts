import { useCallback, useEffect, useState } from 'react'

export const THREADS_UNREAD_ONLY_STORAGE_KEY = 'nessie.threads.unreadOnly'

export const readThreadInboxUnreadOnly = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(THREADS_UNREAD_ONLY_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export const writeThreadInboxUnreadOnly = (unreadOnly: boolean): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THREADS_UNREAD_ONLY_STORAGE_KEY, String(unreadOnly))
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
  }
}

// This is deliberately device-local, rather than part of account preferences:
// the filter is a temporary way to work through an inbox on this device.
export const useThreadInboxUnreadOnly = () => {
  const [unreadOnly, setUnreadOnly] = useState(readThreadInboxUnreadOnly)

  useEffect(() => {
    writeThreadInboxUnreadOnly(unreadOnly)
  }, [unreadOnly])

  const toggleUnreadOnly = useCallback(() => {
    setUnreadOnly((current) => !current)
  }, [])

  return { toggleUnreadOnly, unreadOnly }
}
