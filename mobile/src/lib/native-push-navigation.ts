import { useCallback, useEffect, useRef, useState } from 'react'
import {
  subscribeToPushNavigation,
  takeInitialPushNavigationPath,
} from './push-notifications'

type Input = {
  canNavigate: () => boolean
  navigate: (path: string) => void
}

export type NativePushNavigation = {
  initialPushPath: string | null | undefined
  takePendingPushPath: () => string | null
}

/**
 * Resolves a cold-start notification before the WebView is created, while also
 * retaining a notification that arrives as the authenticated page is loading.
 */
export const useNativePushNavigation = ({ canNavigate, navigate }: Input): NativePushNavigation => {
  const [initialPushPath, setInitialPushPath] = useState<string | null | undefined>(undefined)
  const initialPushPathResolved = useRef(false)
  const pendingPushPath = useRef<string | null>(null)

  const takePendingPushPath = useCallback((): string | null => {
    const path = pendingPushPath.current
    pendingPushPath.current = null
    return path
  }, [])

  useEffect(() => {
    let active = true
    const resolveInitialPushPath = (path: string | null): void => {
      if (initialPushPathResolved.current) return
      initialPushPathResolved.current = true
      setInitialPushPath(path)
    }
    const receivePushPath = (path: string): void => {
      pendingPushPath.current = path
      if (!initialPushPathResolved.current) {
        resolveInitialPushPath(path)
      } else if (canNavigate()) {
        pendingPushPath.current = null
        navigate(path)
      }
    }

    const unsubscribe = subscribeToPushNavigation(receivePushPath)
    void takeInitialPushNavigationPath()
      .then((path) => {
        if (!active) return
        if (path) pendingPushPath.current = path
        resolveInitialPushPath(path)
      })
      .catch(() => {
        if (active) resolveInitialPushPath(null)
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [canNavigate, navigate])

  return { initialPushPath, takePendingPushPath }
}
