import type { NativeShellMessage } from './native-shell-message'

type CallExternalUrlConfig = {
  jitsiDomain: string
}

type WebViewNavigation = {
  isTopFrame: boolean
  url: string
}

export type WebViewNavigationDisposition = 'allow' | 'externalize' | 'block'

export type OpenExternalMessage = NativeShellMessage & {
  type: 'nessie:open-external'
  url: string
}

const jitsiOrigin = (domain: string): string | null => {
  try {
    const parsed = new URL(`https://${domain.trim()}`)
    if (
      parsed.protocol !== 'https:'
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) return null
    return parsed.origin
  } catch {
    return null
  }
}

export const callProviderOrigins = ({ jitsiDomain }: CallExternalUrlConfig): ReadonlySet<string> => {
  const origins = new Set(['https://meet.google.com', 'https://teams.microsoft.com'])
  const configuredJitsiOrigin = jitsiOrigin(jitsiDomain)
  if (configuredJitsiOrigin) origins.add(configuredJitsiOrigin)
  return origins
}

/** The native shell trusts only its own configured provider origins. */
export const isAllowedCallExternalUrl = (
  value: string,
  config: CallExternalUrlConfig,
): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && callProviderOrigins(config).has(parsed.origin)
  } catch {
    return false
  }
}

const isAdminUrl = (value: string, adminUrl: string): boolean => {
  try {
    return new URL(value).origin === new URL(adminUrl).origin
  } catch {
    return false
  }
}

/**
 * Only main-frame navigation may leave Nessie's admin origin. Provider origins
 * open in the system browser; every other top-level origin is blocked while
 * embedded content is left alone.
 */
export const webViewNavigationDisposition = (
  request: WebViewNavigation,
  config: CallExternalUrlConfig & { adminUrl: string },
): WebViewNavigationDisposition => {
  if (!request.isTopFrame) return 'allow'
  if (isAllowedCallExternalUrl(request.url, config)) return 'externalize'
  return isAdminUrl(request.url, config.adminUrl) ? 'allow' : 'block'
}

export const isOpenExternalMessage = (message: NativeShellMessage): message is OpenExternalMessage =>
  message.type === 'nessie:open-external' && typeof message.url === 'string'

type OpenUrl = (url: string) => Promise<unknown>

/** Open an allowlisted call URL without exposing arbitrary URL launching to the page. */
export const openAllowedCallExternalUrl = (
  url: string,
  config: CallExternalUrlConfig,
  openUrl: OpenUrl,
): boolean => {
  if (!isAllowedCallExternalUrl(url, config)) {
    console.warn('[mobile] blocked non-allowlisted external call URL')
    return false
  }
  void openUrl(url).catch(() => {
    console.warn('[mobile] could not open allowlisted external call URL')
  })
  return true
}
