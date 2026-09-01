import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import './notifications.css'

const TOAST_TTL_MS = 7_000
const MAX_TOASTS = 3

export type ToastInput = {
  body: string
  title: string
  // Optional activation for a clickable toast (e.g. "open the channel this
  // message arrived in"). Toasts without it are read-only status.
  onOpen?: () => void
}

type Toast = ToastInput & { id: string }

type ToastApi = {
  pushToast: (toast: ToastInput) => void
}

const ToastContext = createContext<ToastApi | null>(null)

type ToastViewportProps = {
  onDismiss: (toastId: string) => void
  onOpen: (toast: Toast) => void
  toasts: Toast[]
}

const ToastViewport = ({ onDismiss, onOpen, toasts }: ToastViewportProps) => {
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
          {toast.onOpen ? (
            <button
              className="notification-toast-content"
              onClick={() => onOpen(toast)}
              type="button"
            >
              <span className="notification-toast-title">{toast.title}</span>
              <span className="notification-toast-body">{toast.body}</span>
            </button>
          ) : (
            <span className="notification-toast-content">
              <span className="notification-toast-title">{toast.title}</span>
              <span className="notification-toast-body">{toast.body}</span>
            </span>
          )}
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

/**
 * The admin shell's single toast surface. It owns the stack, the auto-dismiss
 * timers, and the one viewport rendered in the corner; every producer (message
 * notifications, run continuation, …) pushes through `useToasts`.
 */
export const ToastProvider = ({ children }: PropsWithChildren) => {
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimersRef = useRef<number[]>([])

  const dismissToast = useCallback((toastId: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== toastId))
  }, [])

  const pushToast = useCallback((toast: ToastInput) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    setToasts((current) => [{ ...toast, id }, ...current].slice(0, MAX_TOASTS))

    const timer = window.setTimeout(() => {
      dismissToast(id)
      toastTimersRef.current = toastTimersRef.current.filter((candidate) => candidate !== timer)
    }, TOAST_TTL_MS)
    toastTimersRef.current.push(timer)
  }, [dismissToast])

  const openToast = useCallback((toast: Toast) => {
    dismissToast(toast.id)
    toast.onOpen?.()
  }, [dismissToast])

  useEffect(() => () => {
    for (const timer of toastTimersRef.current) {
      window.clearTimeout(timer)
    }
    toastTimersRef.current = []
  }, [])

  const api = useMemo<ToastApi>(() => ({ pushToast }), [pushToast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport onDismiss={dismissToast} onOpen={openToast} toasts={toasts} />
    </ToastContext.Provider>
  )
}

export const useToasts = (): ToastApi => {
  const api = useContext(ToastContext)
  if (!api) {
    throw new Error('useToasts must be used within a ToastProvider')
  }
  return api
}
