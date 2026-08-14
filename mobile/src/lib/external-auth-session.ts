import * as WebBrowser from 'expo-web-browser'
import {
  runExternalAuthSession,
  type NativeExternalAuthResult,
} from './external-auth-bridge'

// Deep-link callback the OS browser redirects to after external sign-in. Must
// match the admin's externalAuthRedirectUri and the API's allow-listed URL.
const AUTH_CALLBACK_URL = 'nessie://auth/callback'

export const completeExternalAuth = async (
  authorizeUrl: string,
): Promise<NativeExternalAuthResult> =>
  runExternalAuthSession(authorizeUrl, AUTH_CALLBACK_URL, WebBrowser.openAuthSessionAsync)
