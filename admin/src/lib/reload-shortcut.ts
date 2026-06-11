import { isDesktopApp } from './desktop'

// In embedded webviews (the Tauri desktop app and the React Native WebView shell
// on iPad/iPhone) Cmd/Ctrl+R does nothing by default — there's no browser chrome
// to handle it. Wire it up so a connected hardware keyboard can refresh the app.
// Regular browsers handle Cmd/Ctrl+R natively, so this stays a no-op there.
const isReactNativeWebView = (): boolean =>
  typeof window !== 'undefined' && 'ReactNativeWebView' in window

export const installReloadShortcut = (): void => {
  if (typeof window === 'undefined') return
  if (!isDesktopApp() && !isReactNativeWebView()) return

  window.addEventListener('keydown', (event) => {
    const isReload = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'r'
    if (!isReload) return
    event.preventDefault()
    window.location.reload()
  })
}
