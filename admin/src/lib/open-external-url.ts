import { isDesktopApp } from './desktop'
import { isReactNativeWebView } from './mobile-shell'

type NativeShellWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

export type ExternalUrlDispatch = 'browser' | 'desktop' | 'mobile'

export type ExternalUrlDispatchDeps = {
  isDesktop: () => boolean
  isMobile: () => boolean
  openDesktopUrl: (url: string) => Promise<void>
  postMobileMessage: (message: string) => void
}

/** Whether an admin shell, rather than the browser, owns external navigation. */
export const usesExternalUrlShell = (): boolean => isDesktopApp() || isReactNativeWebView()

/**
 * Routes external call links through a native shell when one owns the browser.
 * A browser result intentionally leaves navigation to the real anchor click.
 */
export const dispatchExternalUrl = async (
  url: string,
  deps: ExternalUrlDispatchDeps,
): Promise<ExternalUrlDispatch> => {
  if (deps.isDesktop()) {
    await deps.openDesktopUrl(url)
    return 'desktop'
  }
  if (deps.isMobile()) {
    deps.postMobileMessage(JSON.stringify({ type: 'nessie:open-external', url }))
    return 'mobile'
  }
  return 'browser'
}

const openDesktopUrl = async (url: string): Promise<void> => {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

const postMobileMessage = (message: string): void => {
  ;(window as NativeShellWindow).ReactNativeWebView?.postMessage(message)
}

/**
 * Opens an external URL from an admin shell. Regular browsers receive
 * `'browser'` so callers keep the action as a real noopener anchor click.
 */
export const openExternalUrl = (url: string): Promise<ExternalUrlDispatch> =>
  dispatchExternalUrl(url, {
    isDesktop: isDesktopApp,
    isMobile: isReactNativeWebView,
    openDesktopUrl,
    postMobileMessage,
  })
