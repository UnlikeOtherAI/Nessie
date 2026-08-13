import { useCallback, type PropsWithChildren } from 'react'
import { useNavigate } from 'react-router-dom'
import { buildChannelMessagePath } from '@nessie/schemas'
import {
  useMessageNotifications,
  type NotificationToastInput,
} from '../facades/notifications/useMessageNotifications'
import { shouldShowInAppMessageBanner } from '../facades/notifications/in-app-message-banner'
import { isReactNativeWebView } from '../lib/mobile-shell'
import { useToasts } from './ToastProvider'

/**
 * Turns realtime `message.new` events into toasts. The toast stack itself lives
 * in `ToastProvider` — this component is purely the message-notification
 * producer, so other surfaces can share the same corner viewport.
 */
export const NotificationsProvider = ({ children }: PropsWithChildren) => {
  const navigate = useNavigate()
  const { pushToast } = useToasts()

  const openChannel = useCallback((channelId: string, threadId?: string, rootMessageId?: string) => {
    window.focus()
    void navigate(
      threadId && rootMessageId
        ? buildChannelMessagePath({ channelId, messageId: rootMessageId, rootMessageId, threadId })
        : `/channels/${channelId}`,
    )
  }, [navigate])

  const addToast = useCallback((toast: NotificationToastInput) => {
    if (!shouldShowInAppMessageBanner(isReactNativeWebView())) {
      return
    }
    pushToast({
      body: toast.body,
      onOpen: () => openChannel(toast.channelId, toast.threadId, toast.rootMessageId),
      title: toast.title,
    })
  }, [openChannel, pushToast])

  useMessageNotifications({
    onToast: addToast,
    openChannel,
  })

  return <>{children}</>
}
