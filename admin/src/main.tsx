import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/geist'
import { AppProvider } from './providers/AppProvider'
import { installBuildFreshnessCheck } from './lib/build-freshness'
import { disableWebviewZoom } from './lib/disable-zoom'
import { installReloadShortcut } from './lib/reload-shortcut'
import { serviceWorkerUrl } from './lib/web-push'
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
    navigator.serviceWorker.register(serviceWorkerUrl()).catch(() => undefined)
  })
}

// The navigation stack owns scroll: retained layers keep their position and
// a fresh push starts at 0 (docs/navigation/overview.md §12). The browser's own
// restoration would fight that on every history step.
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider />
  </React.StrictMode>,
)
