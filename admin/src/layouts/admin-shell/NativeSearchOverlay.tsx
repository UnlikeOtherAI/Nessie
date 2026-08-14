import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { isReactNativeWebView, useNativeIPadApp } from '../../lib/mobile-shell'
import { TopBarSearch } from './TopBarSearch'
import { useTransientMenu } from './TransientMenuContext'

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

const OPEN_EVENT = 'nessie:open-search-overlay'
const CLOSE_EVENT = 'nessie:close-search-overlay'

const postOverlayState = (active: boolean) => {
  if (!isReactNativeWebView()) return
  const rnWindow = window as RnWindow
  rnWindow.ReactNativeWebView?.postMessage(
    JSON.stringify({ type: 'nessie:search-overlay', active }),
  )
}

export const NativeSearchOverlay = () => {
  const location = useLocation()
  const nativeIPadApp = useNativeIPadApp()
  const { close, isOpen: open, open: openMenu } = useTransientMenu()

  useEffect(() => {
    const openOverlay = () => openMenu()
    const closeOverlay = () => close()
    window.addEventListener(OPEN_EVENT, openOverlay)
    window.addEventListener(CLOSE_EVENT, closeOverlay)
    return () => {
      window.removeEventListener(OPEN_EVENT, openOverlay)
      window.removeEventListener(CLOSE_EVENT, closeOverlay)
    }
  }, [close, openMenu])

  useEffect(() => {
    if (open) close()
  }, [location.pathname])

  useEffect(() => {
    postOverlayState(open)
  }, [open])

  if (!open) return null

  return (
    <div className="native-search-overlay" role="presentation">
      <button
        aria-label="Close search"
        className="native-search-overlay-backdrop"
        onClick={close}
        type="button"
      />
      <div
        aria-label="Search"
        aria-modal="true"
        className="native-search-overlay-panel"
        role="dialog"
        style={nativeIPadApp ? { marginTop: 12 } : undefined}
      >
        <TopBarSearch autoFocus onDismiss={close} variant="overlay" />
      </div>
    </div>
  )
}
