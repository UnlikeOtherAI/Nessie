import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppProvider } from './providers/AppProvider'
import { installBuildFreshnessCheck } from './lib/build-freshness'
import { disableWebviewZoom } from './lib/disable-zoom'
import { installReloadShortcut } from './lib/reload-shortcut'
import './styles.css'

// Webview-shell behaviours (no-ops in regular browsers): Cmd/Ctrl+R refresh and
// locking out pinch/keyboard zoom.
installReloadShortcut()
disableWebviewZoom()
installBuildFreshnessCheck()
// Register the service worker (web push + notification clicks). Guarded for
// browsers / webviews without service-worker support; failures are non-fatal.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider />
  </React.StrictMode>,
)
