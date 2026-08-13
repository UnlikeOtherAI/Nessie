import * as WebBrowser from 'expo-web-browser'

// Deep-link callback the OS browser redirects to after external sign-in. Must
// match the admin's externalAuthRedirectUri and the API's allow-listed URL.
const AUTH_CALLBACK_URL = 'nessie://auth/callback'

export const completeExternalAuth = async (authorizeUrl: string): Promise<string | null> => {
  const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_CALLBACK_URL)
  return result.type === 'success' && result.url ? result.url : null
}
