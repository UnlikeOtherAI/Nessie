import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppProvider } from './providers/AppProvider'
import { installReloadShortcut } from './lib/reload-shortcut'
import './styles.css'

// Cmd/Ctrl+R refresh for the desktop + mobile WebView shells (no-op in browsers).
installReloadShortcut()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider />
  </React.StrictMode>,
)
