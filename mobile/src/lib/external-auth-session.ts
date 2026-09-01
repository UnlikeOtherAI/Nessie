import * as WebBrowser from 'expo-web-browser'
import {
  externalAuthErrorResult,
  mapExternalAuthSessionResult,
  type ExternalAuthTerminalResult,
} from './external-auth-delivery'

const AUTH_CALLBACK_URL = 'nessie://auth/callback'
export const completeExternalAuth = async (
  authorizeUrl: string,
  state?: string,
): Promise<ExternalAuthTerminalResult> => {
  try {
    return mapExternalAuthSessionResult(
      await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_CALLBACK_URL),
      state,
    )
  } catch {
    return externalAuthErrorResult(state)
  }
}
