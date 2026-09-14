import { useEffect } from 'react'
import {
  isIosPhoneShell,
  isTransparentColour,
  NATIVE_CHROME_PALETTE_CLASS,
  NATIVE_CHROME_PALETTE_SELECTOR,
  readNativeBackdrop,
  readNativeChromeTheme,
} from '../lib/native-chrome-theme'
import { isReactNativeWebView, readNativeShellInfo } from '../lib/native-shell'

type NativeChromeWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  /** Read by the shell's injected script: the page publishes `theme` and `bg`. */
  __nessieChromeThemePublisher?: boolean
}

/**
 * Installed shells that predate `__nessieChromeThemePublisher` still post their
 * own `theme`/`bg` from the document root, re-reading for 600ms after a change
 * (mobile/src/lib/webview-inject.ts). The native side keeps whichever arrived
 * last, so every change is posted again once that window has closed.
 */
const REPOST_AFTER_LEGACY_SETTLE_MS = 700

/**
 * Publishes the chrome palette to the native shell
 * (docs/navigation/native-shell.md, "`theme` and `bg`"). Must render as a
 * direct child of `.admin-frame`: the element it renders is where the palette
 * is read, and styles.css addresses it there.
 */
export const NativeChromeThemeBridge = () => {
  useEffect(() => {
    if (!isReactNativeWebView()) return undefined
    const target = window as NativeChromeWindow
    target.__nessieChromeThemePublisher = true
    const iosPhone = isIosPhoneShell(readNativeShellInfo())

    const post = (): void => {
      const probe = document.querySelector(NATIVE_CHROME_PALETTE_SELECTOR)
      const bridge = target.ReactNativeWebView
      if (!probe || !bridge) return
      const palette = getComputedStyle(probe)
      const frame = probe.parentElement
      const shell = frame?.classList.contains('focus-mode')
        ? frame.querySelector(':scope > .admin-shell')
        : null
      const shellBackground = shell ? getComputedStyle(shell).backgroundColor : ''
      const focusSurface = shell && !isTransparentColour(shellBackground) ? shellBackground : null
      bridge.postMessage(JSON.stringify(readNativeChromeTheme(palette)))
      bridge.postMessage(JSON.stringify({
        type: 'bg',
        color: readNativeBackdrop({ focusSurface, iosPhone, palette }),
      }))
    }

    let repost: number | undefined
    const schedule = (): void => {
      post()
      window.clearTimeout(repost)
      repost = window.setTimeout(post, REPOST_AFTER_LEGACY_SETTLE_MS)
    }

    // A theme switch writes `data-theme`; the organisation palette is a
    // <style> in <head>; focus mode is a class on the frame.
    const rootObserver = new MutationObserver(schedule)
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    const headObserver = new MutationObserver(schedule)
    headObserver.observe(document.head, { characterData: true, childList: true, subtree: true })
    const frameObserver = new MutationObserver(schedule)
    const frame = document.querySelector(NATIVE_CHROME_PALETTE_SELECTOR)?.parentElement
    if (frame) frameObserver.observe(frame, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('load', schedule)
    schedule()

    return () => {
      rootObserver.disconnect()
      headObserver.disconnect()
      frameObserver.disconnect()
      window.removeEventListener('load', schedule)
      window.clearTimeout(repost)
      delete target.__nessieChromeThemePublisher
    }
  }, [])

  return <span aria-hidden="true" className={NATIVE_CHROME_PALETTE_CLASS} hidden />
}
