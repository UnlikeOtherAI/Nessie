import { useCallback, type PropsWithChildren } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useMessageNotifications,
  type NotificationToastInput,
} from '../facades/notifications/useMessageNotifications'
import { useToasts } from './ToastProvider'

/**
 * Turns realtime `message.new` events into toasts. The toast stack itself lives
 * in `ToastProvider` — this component is purely the message-notification
 * producer, so other surfaces can share the same corner viewport.
 */
export const NotificationsProvider = ({ children }: PropsWithChildren) => {
  const navigate = useNavigate()
  const { pushToast } = useToasts()

  const openChannel = useCallback((channelId: string) => {
    window.focus()
    void navigate(`/channels/${channelId}`)
  }, [navigate])

  const addToast = useCallback((toast: NotificationToastInput) => {
    pushToast({
      body: toast.body,
      onOpen: () => openChannel(toast.channelId),
      title: toast.title,
    })
  }, [openChannel, pushToast])

  useMessageNotifications({
    onToast: addToast,
    openChannel,
  })

  return <>{children}</>
}
