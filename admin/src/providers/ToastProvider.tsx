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
import { CardViewport, type CardItem } from '../components/overlays/CardViewport'
// The toast styles are imported by main.tsx beside styles.css: a CSS import
// inside a component module would put it on the graph of every test that
// mounts the shell, and node --test cannot load CSS.

const TOAST_TTL_MS = 7_000
const MAX_TOASTS = 3

// `QueryProvider` builds the app's `QueryClient` — and wires its mutation
// error default — above where `ToastProvider` mounts (inside
// `AdminShellLayout`, well below the router). A `MutationCache.onError`
// cannot reach `useToasts()`, so it calls this module-level sink instead.
// Registered on mount, cleared on unmount; a mutation that fails before the
// shell (and its toasts) exist is dropped rather than queued — a toast about
// a screen the person can no longer see would be a surprise, not a signal.
let mutationErrorSink: ((message: string) => void) | null = null

export const registerMutationErrorSink = (sink: ((message: string) => void) | null): void => {
  mutationErrorSink = sink
}

export const notifyMutationError = (message: string): void => {
  mutationErrorSink?.(message)
}

export type ToastInput = {
  body: string
  title: string
  // Optional activation for a clickable toast (e.g. "open the channel this
  // message arrived in"). Toasts without it are read-only status.
  onOpen?: () => void
}

// `leaving` is set when the toast is dismissed and cleared only by removal: the
// card plays its close motion first and the row disappears on `onLeft`.
type Toast = ToastInput & { id: string; leaving?: boolean }

type ToastApi = {
  pushToast: (toast: ToastInput) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * The admin shell's single toast surface. It owns the stack and the auto-dismiss
 * timers; every producer (message notifications, run continuation, …) pushes
 * through `useToasts`.
 *
 * The corner region, the layer and the motion belong to the one
 * {@link CardViewport} — a toast is the Card kind of overlay
 * (docs/navigation/overview.md §7), so it never owns Back, never traps focus, keeps its
 * `role="status"`, and waits for a stack transition to settle before it slides
 * in rather than running a second motion across a moving screen.
 */
export const ToastProvider = ({ children }: PropsWithChildren) => {
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimersRef = useRef<number[]>([])

  const dismissToast = useCallback((toastId: string) => {
    setToasts((current) =>
      current.map((toast) => (toast.id === toastId ? { ...toast, leaving: true } : toast)),
    )
  }, [])

  const removeToast = useCallback((toastId: string) => {
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

  useEffect(() => {
    registerMutationErrorSink((message) => pushToast({ body: message, title: 'Something went wrong' }))
    return () => registerMutationErrorSink(null)
  }, [pushToast])

  const api = useMemo<ToastApi>(() => ({ pushToast }), [pushToast])

  const cards = useMemo<CardItem[]>(() => toasts.map((toast) => ({
    children: (
      <div className="notification-toast">
        {toast.onOpen ? (
          <button
            className="notification-toast-content"
            onClick={() => openToast(toast)}
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
          onClick={() => dismissToast(toast.id)}
          type="button"
        >
          x
        </button>
      </div>
    ),
    id: toast.id,
    leaving: toast.leaving,
  })), [dismissToast, openToast, toasts])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <CardViewport cards={cards} onLeft={removeToast} />
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
