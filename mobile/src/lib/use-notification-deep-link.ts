import { useRootNavigationState, useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useState } from 'react'

import { useAuth } from './auth-context'

// The worker push-dispatch sends `data = { channelId, threadId, messageId }`.
type PushData = {
  channelId?: unknown
}

const extractChannelId = (response: Notifications.NotificationResponse): string | null => {
  const data = response.notification.request.content.data as PushData | undefined
  return typeof data?.channelId === 'string' ? data.channelId : null
}

/**
 * Deep-link a notification tap to the relevant channel thread. Handles both the
 * cold-start case (app launched from a notification) and taps while running.
 */
export const useNotificationDeepLink = (): void => {
  const { status } = useAuth()
  const router = useRouter()
  const rootNavigationState = useRootNavigationState()
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null)
  const rootNavigationReady = Boolean(rootNavigationState?.key)

  const queueResponse = useCallback((response: Notifications.NotificationResponse): void => {
    const channelId = extractChannelId(response)
    if (channelId) {
      setPendingChannelId(channelId)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    // Cold start: the app was opened by tapping a notification.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (cancelled || !response) {
        return
      }
      queueResponse(response)
    })

    // Warm taps while the app is running.
    const subscription = Notifications.addNotificationResponseReceivedListener(queueResponse)

    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [queueResponse])

  useEffect(() => {
    if (!pendingChannelId || status !== 'signed-in' || !rootNavigationReady) {
      return
    }
    const channelId = pendingChannelId
    setPendingChannelId(null)
    router.push(`/(app)/channels/${channelId}`)
  }, [pendingChannelId, rootNavigationReady, router, status])
}
