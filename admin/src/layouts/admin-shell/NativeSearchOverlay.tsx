import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { isReactNativeWebView } from '../../lib/mobile-shell'
import { TopBarSearch } from './TopBarSearch'

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
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const openOverlay = () => setOpen(true)
    const closeOverlay = () => setOpen(false)
    window.addEventListener(OPEN_EVENT, openOverlay)
    window.addEventListener(CLOSE_EVENT, closeOverlay)
    return () => {
      window.removeEventListener(OPEN_EVENT, openOverlay)
      window.removeEventListener(CLOSE_EVENT, closeOverlay)
    }
  }, [])

  useEffect(() => {
    if (open) setOpen(false)
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
        onClick={() => setOpen(false)}
        type="button"
      />
      <div
        aria-label="Search"
        aria-modal="true"
        className="native-search-overlay-panel"
        role="dialog"
      >
        <TopBarSearch autoFocus onDismiss={() => setOpen(false)} variant="overlay" />
      </div>
    </div>
  )
}
