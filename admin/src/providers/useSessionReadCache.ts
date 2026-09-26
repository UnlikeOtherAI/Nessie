import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createReadQueryCache } from '../lib/read-query-cache'
import { projectCachedRead } from './read-cache-policy'

/** Binds disk writes to the page lifecycle and the authenticated session. */
export const useSessionReadCache = () => {
  const queryClient = useQueryClient()
  const readCache = useMemo(() => createReadQueryCache({
    queryClient,
    storage: () => window.localStorage,
    project: projectCachedRead,
  }), [queryClient])
  useEffect(() => {
    readCache.start()
    const flushHidden = () => { if (document.visibilityState === 'hidden') readCache.flush() }
    window.addEventListener('pagehide', readCache.flush)
    document.addEventListener('visibilitychange', flushHidden)
    return () => {
      window.removeEventListener('pagehide', readCache.flush)
      document.removeEventListener('visibilitychange', flushHidden)
      readCache.stop()
    }
  }, [queryClient, readCache])
  return readCache
}
