import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useMessageNotifications,
  type NotificationToastInput,
} from '../facades/notifications/useMessageNotifications'
import './notifications.css'

const TOAST_TTL_MS = 7_000
const MAX_TOASTS = 3

type NotificationToast = NotificationToastInput & {
  id: string
}

type NotificationToastViewportProps = {
  onDismiss: (toastId: string) => void
  onOpen: (toast: NotificationToast) => void
  toasts: NotificationToast[]
}

const NotificationToastViewport = ({
  onDismiss,
  onOpen,
  toasts,
}: NotificationToastViewportProps) => {
  if (toasts.length === 0) {
    return null
  }

  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      className="notification-toast-viewport"
    >
      {toasts.map((toast) => (
        <div className="notification-toast" key={toast.id} role="status">
          <button
            className="notification-toast-content"
            onClick={() => onOpen(toast)}
            type="button"
          >
            <span className="notification-toast-title">{toast.title}</span>
            <span className="notification-toast-body">{toast.body}</span>
          </button>
          <button
            aria-label="Dismiss notification"
            className="notification-toast-dismiss"
            onClick={() => onDismiss(toast.id)}
            type="button"
          >
            x
          </button>
        </div>
      ))}
    </div>
  )
}

export const NotificationsProvider = ({ children }: PropsWithChildren) => {
  const navigate = useNavigate()
  const [toasts, setToasts] = useState<NotificationToast[]>([])
  const toastTimersRef = useRef<number[]>([])

  const dismissToast = useCallback((toastId: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId))
  }, [])

  const openChannel = useCallback((channelId: string) => {
    window.focus()
    void navigate(`/channels/${channelId}`)
  }, [navigate])

  const addToast = useCallback((toast: NotificationToastInput) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    setToasts((current) => [{ ...toast, id }, ...current].slice(0, MAX_TOASTS))

    const timer = window.setTimeout(() => {
      dismissToast(id)
      toastTimersRef.current = toastTimersRef.current.filter((candidate) => candidate !== timer)
    }, TOAST_TTL_MS)
    toastTimersRef.current.push(timer)
  }, [dismissToast])

  const openToast = useCallback((toast: NotificationToast) => {
    dismissToast(toast.id)
    openChannel(toast.channelId)
  }, [dismissToast, openChannel])

  useEffect(() => () => {
    for (const timer of toastTimersRef.current) {
      window.clearTimeout(timer)
    }
    toastTimersRef.current = []
  }, [])

  useMessageNotifications({
    onToast: addToast,
    openChannel,
  })

  return (
    <>
      {children}
      <NotificationToastViewport
        onDismiss={dismissToast}
        onOpen={openToast}
        toasts={toasts}
      />
    </>
  )
}
