import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import type { AuthSessionState } from '@nessie/client-core'
import { completeExternalAuthCallback, EXPIRED_SIGN_IN_MESSAGE } from '../lib/external-auth-completion'
import { completedExternalAuthCallbackCache } from '../lib/pkce'
import { isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/native-shell'
import { NATIVE_EXTERNAL_AUTH_EVENT } from '../lib/native-external-auth'
import { useAuthSession } from './AuthSessionProvider'
import { createExternalAuthCallbackHub } from '../lib/external-auth-callback'
import {
  ExternalAuthNavigationContext,
  type ExternalAuthNavigation,
} from './external-auth-navigation'

const noticeClass = [
  'fixed inset-x-0 top-2 z-50 mx-auto w-fit max-w-[min(90vw,32rem)]',
  'rounded-xl border border-[color:var(--danger-border,rgba(220,80,80,0.45))]',
  'bg-[color:var(--surface-overlay,var(--app-surface,#1c1f24))] px-4 py-2',
  'text-[13px] leading-snug text-[color:var(--danger-text,#f2a0a0)] shadow-lg',
].join(' ')

type NativeCallbackWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieExternalAuthCallback?: (url: string) => Promise<void>
}

export const ExternalAuthProvider = ({ children }: PropsWithChildren) => {
  const { login, recoveryExchange, sessionState } = useAuthSession()
  const [notice, setNotice] = useState<string | null>(null)
  const navigateRef = useRef<(path: string) => void>(() => undefined)
  const sessionStateRef = useRef(sessionState)
  sessionStateRef.current = sessionState
  const sessionWaiters = useRef<Array<(state: AuthSessionState) => void>>([])
  const loginRef = useRef(login)
  loginRef.current = login
  const recoveryRef = useRef(recoveryExchange)
  recoveryRef.current = recoveryExchange

  useEffect(() => {
    if (sessionState === 'loading') return
    const waiters = sessionWaiters.current.splice(0)
    waiters.forEach((resolve) => resolve(sessionState))
  }, [sessionState])

  const hub = useMemo(() => {
    const publishTerminalResult = (message: string, returnPath: string, cancelled = false): void => {
      setNotice(message)
      // Settle any screen that started this sign-in and is still showing a
      // spinner (the login screen subscribes while unauthenticated).
      window.dispatchEvent(new CustomEvent(NATIVE_EXTERNAL_AUTH_EVENT, {
        detail: cancelled ? { type: 'cancelled' } : { message, type: 'failed' },
      }))
      navigateRef.current(returnPath)
    }

    return createExternalAuthCallbackHub(async (envelope) => {
      const result = await completeExternalAuthCallback({
        envelope,
        login: (value) => loginRef.current(value),
        recoveryExchange: (value, target) => recoveryRef.current(value, target),
        waitForSessionReady: () => {
          const current = sessionStateRef.current
          return current === 'loading'
            ? new Promise((resolve) => sessionWaiters.current.push(resolve))
            : Promise.resolve(current)
        },
      })
      if (result.outcome === 'completed') {
        navigateRef.current(result.returnPath)
      } else {
        publishTerminalResult(result.message, result.returnPath, result.outcome === 'cancelled')
      }
      return result.claimed
    }, completedExternalAuthCallbackCache, async () => {
      publishTerminalResult(EXPIRED_SIGN_IN_MESSAGE, '/login')
    })
  }, [])

  const registerNavigate = useCallback((navigate: (path: string) => void): (() => void) => {
    navigateRef.current = navigate
    hub.setReady(true)
    const native = window as NativeCallbackWindow
    native.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'nessie:external-auth-ready' }))
    return () => {
      hub.setReady(false)
      navigateRef.current = () => undefined
    }
  }, [hub])

  const handleWebLocation = useCallback((url: string, origin: string) => {
    void hub.handleWebUrl(url, origin).catch(() => {
      setNotice('The external sign-in could not be completed.')
    })
  }, [hub])

  const value = useMemo<ExternalAuthNavigation>(
    () => ({ handleWebLocation, registerNavigate }),
    [handleWebLocation, registerNavigate],
  )

  useEffect(() => {
    if (isReactNativeWebView()) {
      const target = window as NativeCallbackWindow
      target.__nessieExternalAuthCallback = hub.handleNativeUrl
      target.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'nessie:external-auth-ready' }))
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    if (isDesktopApp()) {
      void (async () => {
        const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
        const currentUrls = await getCurrent()
        if (disposed) return
        currentUrls?.forEach((url) => void hub.handleNativeUrl(url).catch(() => undefined))
        unlisten = await onOpenUrl((urls) => {
          urls.forEach((url) => void hub.handleNativeUrl(url).catch(() => undefined))
        })
        if (disposed) unlisten()
      })().catch(() => {
        if (!disposed) setNotice('The external sign-in could not be completed.')
      })
    }

    return () => {
      disposed = true
      unlisten?.()
      const target = window as NativeCallbackWindow
      if (target.__nessieExternalAuthCallback === hub.handleNativeUrl) {
        delete target.__nessieExternalAuthCallback
      }
    }
  }, [hub])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 8_000)
    return () => clearTimeout(timer)
  }, [notice])

  return (
    <ExternalAuthNavigationContext.Provider value={value}>
      {children}
      {notice ? <p role="alert" className={noticeClass}>{notice}</p> : null}
    </ExternalAuthNavigationContext.Provider>
  )
}
