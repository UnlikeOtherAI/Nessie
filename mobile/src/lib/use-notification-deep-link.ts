import { useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useEffect } from 'react'

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
  const router = useRouter()

  useEffect(() => {
    let cancelled = false

    // Cold start: the app was opened by tapping a notification.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (cancelled || !response) {
        return
      }
      const channelId = extractChannelId(response)
      if (channelId) {
        router.push(`/(app)/channels/${channelId}`)
      }
    })

    // Warm taps while the app is running.
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const channelId = extractChannelId(response)
      if (channelId) {
        router.push(`/(app)/channels/${channelId}`)
      }
    })

    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [router])
}
