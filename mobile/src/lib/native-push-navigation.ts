import { useCallback, useEffect, useRef, useState } from 'react'
import {
  subscribeToPushNavigation,
  takeInitialPushNavigationPath,
} from './push-notifications'

type Input = {
  cachePushPath: (path: string) => void
}

export type NativePushNavigation = {
  initialPushPathResolved: boolean
  pendingPushPath: string | null
  acknowledgePushPath: (path: string) => boolean
  replayPendingPushPath: () => string | null
}

/**
 * Caches a notification route until the WebView's React router reports that it
 * has reached that exact path. Direct injection during a cold start is racy:
 * the router can initialise its default Personal Assistant route afterward.
 */
export const useNativePushNavigation = ({ cachePushPath }: Input): NativePushNavigation => {
  const [initialPushPathResolved, setInitialPushPathResolved] = useState(false)
  const [pendingPushPath, setPendingPushPath] = useState<string | null>(null)
  const initialPushPathResolvedRef = useRef(false)
  const pendingPushPathRef = useRef<string | null>(null)

  const replayPendingPushPath = useCallback((): string | null => {
    const path = pendingPushPathRef.current
    if (path) cachePushPath(path)
    return path
  }, [cachePushPath])

  const acknowledgePushPath = useCallback((path: string): boolean => {
    if (pendingPushPathRef.current !== path) return false
    pendingPushPathRef.current = null
    setPendingPushPath(null)
    return true
  }, [])

  useEffect(() => {
    let active = true
    const resolveInitialPushPath = (path: string | null): void => {
      if (initialPushPathResolvedRef.current) return
      initialPushPathResolvedRef.current = true
      if (path) {
        pendingPushPathRef.current = path
        setPendingPushPath(path)
      }
      setInitialPushPathResolved(true)
    }
    const receivePushPath = (path: string): void => {
      pendingPushPathRef.current = path
      setPendingPushPath(path)
      if (!initialPushPathResolvedRef.current) {
        resolveInitialPushPath(path)
      } else {
        cachePushPath(path)
      }
    }

    const unsubscribe = subscribeToPushNavigation(receivePushPath)
    void takeInitialPushNavigationPath()
      .then((path) => {
        if (!active) return
        resolveInitialPushPath(path)
      })
      .catch(() => {
        if (active) resolveInitialPushPath(null)
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [cachePushPath])

  return {
    acknowledgePushPath,
    initialPushPathResolved,
    pendingPushPath,
    replayPendingPushPath,
  }
}
