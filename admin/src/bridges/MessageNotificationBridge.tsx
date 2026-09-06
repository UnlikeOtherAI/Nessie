import { useCallback, useEffect, type PropsWithChildren } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useMessageNotifications,
  type NotificationToastInput,
} from '../facades/notifications/useMessageNotifications'
import { shouldShowInAppMessageBanner } from '../facades/notifications/in-app-message-banner'
import {
  buildMessageNotificationPath,
  DESKTOP_NOTIFICATION_OPEN_EVENT,
  readDesktopNotificationOpenPath,
} from '../facades/notifications/desktop-native-notification'
import { consumeDesktopPendingPath, isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/native-shell'
import { useToasts } from '../providers/ToastProvider'
import { useFocusMode } from '../providers/FocusModeProvider'

/**
 * Turns realtime `message.new` events into toasts. The toast stack itself lives
 * in `ToastProvider` — this component is purely the message-notification
 * producer, so other surfaces can share the same corner viewport.
 */
export const MessageNotificationBridge = ({ children }: PropsWithChildren) => {
  const navigate = useNavigate()
  const { pushToast } = useToasts()
  const { focusModeEnabled } = useFocusMode()

  const openChannel = useCallback((channelId: string, threadId?: string, rootMessageId?: string) => {
    window.focus()
    void navigate(buildMessageNotificationPath({ channelId, rootMessageId, threadId }))
  }, [navigate])

  useEffect(() => {
    if (!isDesktopApp()) return undefined
    const openDesktopNotification = (event: Event) => {
      const path = readDesktopNotificationOpenPath(event)
      // The live subscriber consumes the retained copy, so the root
      // redirect never replays a click that was already handled here.
      consumeDesktopPendingPath()
      if (path) {
        window.focus()
        void navigate(path)
      }
    }
    window.addEventListener(DESKTOP_NOTIFICATION_OPEN_EVENT, openDesktopNotification)
    return () => window.removeEventListener(DESKTOP_NOTIFICATION_OPEN_EVENT, openDesktopNotification)
  }, [navigate])

  const addToast = useCallback((toast: NotificationToastInput) => {
    if (focusModeEnabled || !shouldShowInAppMessageBanner(isReactNativeWebView())) {
      return
    }
    pushToast({
      body: toast.body,
      onOpen: () => openChannel(toast.channelId, toast.threadId, toast.rootMessageId),
      title: toast.title,
    })
  }, [focusModeEnabled, openChannel, pushToast])

  useMessageNotifications({
    onToast: addToast,
    openChannel,
    suppressNotifications: focusModeEnabled,
  })

  return <>{children}</>
}
