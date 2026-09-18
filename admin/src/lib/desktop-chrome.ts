import { invoke } from '@tauri-apps/api/core'

import { isDesktopApp } from './desktop'
import type { NativeChromeThemeMessage } from './native-chrome-theme'

/**
 * Hands the Tauri window the chrome the page is drawing, because two parts of
 * it are the shell's to paint and not the page's
 * (`desktop_set_chrome` in desktop/src-tauri/src/shell.rs).
 *
 * **The empty window.** Cmd/Ctrl+R throws the document away, and until the next
 * one paints the window is one flat colour. It was fixed in the bundle at
 * `#2e1132` — the rail of the palette that was default before the Nessie theme
 * — so every reload flashed purple before the admin came back in the person's
 * own colours.
 *
 * **Its appearance.** macOS draws the traffic lights, and the screen-sharing
 * control it inserts beside them while a window is shared, in the window's own
 * `NSAppearance`. Following the system rather than the page, that control
 * rendered as a white block on the dark bar.
 *
 * The palette is the chrome's, read off the same `.native-chrome-palette`
 * element the React Native shell reads, so a theme with its own chrome scope
 * and focus mode both reach the window by CSS alone.
 */
export const publishDesktopChrome = (chrome: NativeChromeThemeMessage): void => {
  if (!isDesktopApp() || !chrome.headerSurface) return
  void invoke('desktop_set_chrome', {
    background: chrome.headerSurface,
    scheme: chrome.scheme,
  }).catch(() => undefined)
}
