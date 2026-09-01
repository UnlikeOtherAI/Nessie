/**
 * Where a provider sign-in is shown.
 *
 * One seam, because the answer differs per platform and the flow must not care:
 * the web opens a centred popup, and a native shell hands the URL to its system
 * browser. This is deliberately separate from the native login auth-session:
 * a connector returns to Nessie's HTTPS callback, not to an app deep link, so
 * the detail page has to stay alive underneath and observe its status on return.
 *
 * The contract is deliberately small. `open` returns null when the sign-in could
 * not be shown, and every caller must have an answer for that — on the web it is
 * a blocked popup, and the panel offers the same URL as an ordinary link.
 */

/** The subset of a popup window this flow uses. `Window` satisfies it. */
export type ExternalAuthWindow = {
  close: () => void
  closed: boolean
  focus: () => void
  /**
   * The popup's reference back to us. Only ever *written* — `null`, once, at
   * open time — never read, which is why `unknown` is the honest type. Optional
   * because a launcher host that is not a browser window has no such
   * back-reference to sever.
   */
  opener?: unknown
}

export type AuthHandle = {
  /** Bring the sign-in back to the front — the "didn't open?" affordance. */
  focus: () => void
  /** True once the person (or the callback page) closed it. */
  isClosed: () => boolean
  /**
   * Ask the window to go away when the flow ends before it does. Best-effort by
   * construction: once the popup has navigated to the provider it is neither
   * same-origin nor ours (see `createWindowAuthLauncher`), so the browser
   * declines. The case that matters closes itself — the callback page calls
   * `window.close()` on its own window, which a script-opened window may
   * always do.
   */
  close: () => void
}

export type ExternalAuthLauncher = {
  open: (url: string) => AuthHandle | null
}

/** The one native bridge capability the connector flow needs. */
export type NativeConnectorAuthorizationHost = {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

/**
 * What the web launcher needs from `window`, so a test can supply it. Declared
 * with method syntax on purpose: `window.open`'s wider parameter types then stay
 * assignable.
 */
export type ExternalAuthHost = {
  open(url: string, target: string, features: string): ExternalAuthWindow | null
  outerHeight: number
  outerWidth: number
  screenX: number
  screenY: number
}

/**
 * A sign-in window big enough for a consent screen and small enough to read as
 * a dialog over the page that opened it.
 */
export const AUTH_POPUP_WIDTH = 600
export const AUTH_POPUP_HEIGHT = 760

/**
 * A stable name, so the window we position is the one a person gets. It is no
 * longer a reuse mechanism: once the popup has navigated to the provider we are
 * not familiar with it (`createWindowAuthLauncher` severs the opener), so the
 * name lookup skips it and a second press opens a fresh window.
 */
const AUTH_POPUP_TARGET = 'nessie-connect'

/**
 * Centred on the window the person is looking at, not on the primary display —
 * on a two-monitor desk a screen-centred popup opens on the wrong one.
 */
export const authPopupFeatures = (host: {
  outerHeight: number
  outerWidth: number
  screenX: number
  screenY: number
}): string => {
  const left = Math.max(0, Math.round(host.screenX + (host.outerWidth - AUTH_POPUP_WIDTH) / 2))
  const top = Math.max(0, Math.round(host.screenY + (host.outerHeight - AUTH_POPUP_HEIGHT) / 2))
  return [
    `width=${AUTH_POPUP_WIDTH}`,
    `height=${AUTH_POPUP_HEIGHT}`,
    `left=${left}`,
    `top=${top}`,
    // A real chrome, so the provider's own address bar is visible: a person
    // being asked for their password must be able to see whose page it is.
    'resizable=yes',
    'scrollbars=yes',
  ].join(',')
}

/**
 * The web implementation: a sized, positioned `window.open` whose opener is
 * severed before the provider's page can exist.
 *
 * Never an iframe — providers send `X-Frame-Options`, and a login form inside
 * our own frame hides the URL the person is trusting. Never a full tab either:
 * the opener holds the flow, and replacing it loses the page.
 *
 * **The first thing this window loads is a third party's.** The URL comes from
 * OAuth discovery against a server somebody in this organisation named, so a
 * custom app can point it at an attacker's authorization endpoint. That page
 * cannot *read* `window.opener` across origins, but it may *write*
 * `window.opener.location` — reverse tabnabbing: while the consent screen is
 * being read, the admin tab it came from is silently replaced by a
 * credential-harvesting copy. So the popup's back-reference to us is cut here.
 *
 * The two references are not the same thing, which is what makes this both
 * safe and workable: `popup` (us → the window) is a handle no other page can
 * reach, and it is what reports "blocked" and "closed"; `popup.opener` (the
 * window → us) is the one the attack needs, and nothing in this flow does.
 * `noopener` in the feature string would cut both — `window.open` would return
 * null, leaving no way to tell a blocked popup from a working one and no
 * closure signal at all.
 *
 * Timing is what makes the write reach the right window: navigation is
 * asynchronous, so on the statement after `open` the popup is still its initial
 * `about:blank`, which inherits our origin. Setting `opener` to null there
 * clears it on the browsing *context*, so it stays cleared through every
 * navigation that follows.
 *
 * Completion therefore never arrives by `postMessage` — the callback page posts
 * only `if (window.opener)`. That is the route the design chose anyway: the
 * flow reads connection status on focus and on the popup closing, which is what
 * works when the popup lands in another process or on a phone that left the
 * page entirely.
 */
export const createWindowAuthLauncher = (host: ExternalAuthHost): ExternalAuthLauncher => ({
  open: (url) => {
    const popup = host.open(url, AUTH_POPUP_TARGET, authPopupFeatures(host))
    if (!popup) return null
    popup.opener = null
    popup.focus()
    return {
      close: () => popup.close(),
      focus: () => popup.focus(),
      isClosed: () => popup.closed,
    }
  },
})

/**
 * The React Native implementation. The admin page does not navigate: it asks
 * its persistent native shell to hand this one connector authorization URL to
 * the operating system browser. The native boundary validates it again before
 * launching, because this is intentionally not the generic call-link bridge.
 */
export const createNativeConnectorAuthorizationLauncher = (
  host: NativeConnectorAuthorizationHost,
): ExternalAuthLauncher => ({
  open: (authorizationUrl) => {
    try {
      const bridge = host.ReactNativeWebView
      if (!bridge) return null
      bridge.postMessage(JSON.stringify({
        authorizationUrl,
        type: 'nessie:connector-authorization',
      }))
      // A system browser has no window handle for us to close or focus. It is
      // still an opened launcher: the pending flow polls when the app returns.
      return {
        close: () => undefined,
        focus: () => undefined,
        isClosed: () => false,
      }
    } catch {
      return null
    }
  },
})
