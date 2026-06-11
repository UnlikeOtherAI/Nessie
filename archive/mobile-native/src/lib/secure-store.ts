import * as SecureStore from 'expo-secure-store'

// Persisted auth state keys. SecureStore values are strings only.
const TOKEN_KEY = 'nessie.token'
const BASE_URL_KEY = 'nessie.baseUrl'

// Dev builds default to the Mac's LAN address so a physical device can reach
// the local API; production builds default to the hosted API.
export const DEFAULT_BASE_URL = __DEV__
  ? 'http://192.168.1.229:5554'
  : 'https://api.nessie.unlikeotherai.com'

export const loadToken = async (): Promise<string | null> => {
  return SecureStore.getItemAsync(TOKEN_KEY)
}

export const saveToken = async (token: string): Promise<void> => {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}

export const clearToken = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}

export const loadBaseUrl = async (): Promise<string> => {
  const stored = await SecureStore.getItemAsync(BASE_URL_KEY)
  return stored ?? DEFAULT_BASE_URL
}

export const saveBaseUrl = async (baseUrl: string): Promise<void> => {
  await SecureStore.setItemAsync(BASE_URL_KEY, baseUrl)
}
