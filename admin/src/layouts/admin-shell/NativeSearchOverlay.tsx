import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { isReactNativeWebView } from '../../lib/native-shell'
import { useNativeIPadApp } from '../../navigation/mobile-shell'
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

  // A route change dismisses the overlay. `open` is read through a ref so it
  // is not a dependency: as a dependency it would close the overlay the moment
  // it opened, which is the opposite of what this effect is for.
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (openRef.current) close()
  }, [close, location.pathname])

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
