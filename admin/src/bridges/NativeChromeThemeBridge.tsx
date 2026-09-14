import { useEffect } from 'react'
import {
  isIosPhoneShell,
  isTransparentColour,
  NATIVE_CHROME_PALETTE_CLASS,
  NATIVE_CHROME_PALETTE_SELECTOR,
  readNativeBackdrop,
  readNativeChromeTheme,
  type NativeChromeThemeMessage,
} from '../lib/native-chrome-theme'
import { isReactNativeWebView, readNativeShellInfo } from '../lib/native-shell'
import { ORGANIZATION_THEME_STYLE_ID } from '../lib/theme-storage'

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
export const REPOST_AFTER_LEGACY_SETTLE_MS = 700

const postPalette = (
  bridge: NonNullable<NativeChromeWindow['ReactNativeWebView']>,
  theme: NativeChromeThemeMessage,
  backdrop: string,
): void => {
  bridge.postMessage(JSON.stringify(theme))
  if (backdrop) bridge.postMessage(JSON.stringify({ type: 'bg', color: backdrop }))
}

// Only the organisation palette's own <style> changes the colours; <title> and
// meta churn on every route and must not re-post.
const touchesOrganizationTheme = (records: MutationRecord[]): boolean =>
  records.some((record) => {
    const target = record.target.nodeType === 1
      ? record.target as Element
      : record.target.parentElement
    if (target?.closest?.(`#${ORGANIZATION_THEME_STYLE_ID}`)) return true
    return [...record.addedNodes, ...record.removedNodes]
      .some((node) => (node as Element).id === ORGANIZATION_THEME_STYLE_ID)
  })

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
      postPalette(bridge, readNativeChromeTheme(palette), readNativeBackdrop({ focusSurface, iosPhone, palette }))
    }

    // Leaving the shell (sign-out) hands the shell back the document's own
    // palette, marked as not the page's chrome. The injected script cannot
    // take over by itself: nothing it observes changes, and its dedupe still
    // holds the palette from before this bridge mounted. Deferred a tick so a
    // bridge that remounts in the same commit keeps ownership without a flash.
    const handBack = (): void => {
      const bridge = target.ReactNativeWebView
      if (target.__nessieChromeThemePublisher || !bridge) return
      const bodyBackground = document.body ? getComputedStyle(document.body).backgroundColor : ''
      postPalette(
        bridge,
        readNativeChromeTheme(getComputedStyle(document.documentElement), { fromPage: false }),
        isTransparentColour(bodyBackground) ? '' : bodyBackground,
      )
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
    const headObserver = new MutationObserver((records) => {
      if (touchesOrganizationTheme(records)) schedule()
    })
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
      window.setTimeout(handBack, 0)
    }
  }, [])

  return <span aria-hidden="true" className={NATIVE_CHROME_PALETTE_CLASS} hidden />
}
