import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './native-shell'

// Disable user zoom inside the embedded webviews (Tauri desktop + React Native
// WebView on iPad/iPhone). Accidental pinch / Cmd+/- zoom in an app shell looks
// broken and has no browser chrome to reset it. Regular browsers are left alone
// so their native zoom/accessibility still works.
export const disableWebviewZoom = (): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (!isDesktopApp() && !isReactNativeWebView()) return

  // Lock the viewport. viewport-fit=cover is kept so the mobile safe-area insets
  // (env(safe-area-inset-*)) stay available to the layout.
  let viewport = document.querySelector('meta[name="viewport"]')
  if (!viewport) {
    viewport = document.createElement('meta')
    viewport.setAttribute('name', 'viewport')
    document.head.appendChild(viewport)
  }
  viewport.setAttribute(
    'content',
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
  )

  // Keyboard zoom (Cmd/Ctrl with +, -, =, 0) in the desktop webview.
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && ['+', '-', '=', '0'].includes(event.key)) {
      event.preventDefault()
    }
  })

  // Trackpad/ctrl-wheel zoom.
  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey) event.preventDefault()
    },
    { passive: false },
  )

  // Safari/WKWebView pinch gesture events.
  document.addEventListener('gesturestart', (event: Event) => event.preventDefault())
  document.addEventListener('gesturechange', (event: Event) => event.preventDefault())
}
