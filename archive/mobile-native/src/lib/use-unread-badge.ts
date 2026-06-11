import { useEffect } from 'react'
import * as Notifications from 'expo-notifications'
import { AppState } from 'react-native'

import { useAuth } from './auth-context'
import { useChannels } from './queries'

const setAppBadge = async (count: number): Promise<void> => {
  try {
    await Notifications.setBadgeCountAsync(count)
  } catch {
    // Badge support is platform/device dependent; never block the app on it.
  }
}

export const useUnreadBadge = (): void => {
  const { status } = useAuth()
  const { data: channels, refetch } = useChannels()
  const unreadCount = channels?.reduce((total, channel) => total + channel.unreadCount, 0)

  useEffect(() => {
    if (status === 'signed-out') {
      void setAppBadge(0)
      return
    }
    if (status === 'signed-in' && typeof unreadCount === 'number') {
      void setAppBadge(unreadCount)
    }
  }, [status, unreadCount])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        return
      }
      if (status === 'signed-in') {
        void refetch()
        return
      }
      if (status === 'signed-out') {
        void setAppBadge(0)
      }
    })
    return () => {
      subscription.remove()
    }
  }, [refetch, status])
}
