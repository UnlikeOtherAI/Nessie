import type { NativeShellMessage } from './native-shell-message'

export type ConnectorAuthorizationMessage = NativeShellMessage & {
  authorizationUrl: string
  type: 'nessie:connector-authorization'
}

type OpenUrl = (url: string) => Promise<unknown>

/** A connector authorization target may be dynamic, but it must be a safe HTTPS URL. */
export const isConnectorAuthorizationUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.hostname.length > 0
      && !parsed.username
      && !parsed.password
  } catch {
    return false
  }
}

/** This is a distinct bridge capability, never the generic call-link message. */
export const isConnectorAuthorizationMessage = (
  message: NativeShellMessage,
): message is ConnectorAuthorizationMessage =>
  message.type === 'nessie:connector-authorization'
  && typeof message.authorizationUrl === 'string'

/** Open a validated connector authorization URL in the operating system browser. */
export const openConnectorAuthorizationUrl = (url: string, openUrl: OpenUrl): boolean => {
  if (!isConnectorAuthorizationUrl(url)) {
    console.warn('[mobile] blocked invalid connector authorization URL')
    return false
  }
  try {
    void openUrl(url).catch(() => {
      console.warn('[mobile] could not open connector authorization URL')
    })
  } catch {
    console.warn('[mobile] could not open connector authorization URL')
  }
  return true
}
