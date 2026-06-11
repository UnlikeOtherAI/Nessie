import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppProvider } from './providers/AppProvider'
import { disableWebviewZoom } from './lib/disable-zoom'
import { installReloadShortcut } from './lib/reload-shortcut'
import './styles.css'

// Webview-shell behaviours (no-ops in regular browsers): Cmd/Ctrl+R refresh and
// locking out pinch/keyboard zoom.
installReloadShortcut()
disableWebviewZoom()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider />
  </React.StrictMode>,
)
