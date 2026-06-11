import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

import { createApiClient } from '@nessie/client-core'
import type { RegisterDeviceRequest } from '@nessie/schemas'

type Connection = { baseUrl: string; token: string }

// The native APNs/FCM token. We deliberately use getDevicePushTokenAsync (the
// raw native token), NOT getExpoPushTokenAsync — Nessie runs its own push
// gateway and sends to APNs/FCM directly (see the native-apps-and-push plan).
const getNativeDeviceToken = async (): Promise<string | null> => {
  // Push only exists on real iOS/Android devices. Bail on web / Expo Go /
  // simulators where native registration is unavailable or unsupported.
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return null
  }

  const permission = await Notifications.getPermissionsAsync()
  let granted = permission.granted
  if (!granted && permission.canAskAgain) {
    granted = (await Notifications.requestPermissionsAsync()).granted
  }
  if (!granted) {
    return null
  }

  const devicePushToken = await Notifications.getDevicePushTokenAsync()
  return typeof devicePushToken.data === 'string' ? devicePushToken.data : null
}

/**
 * Register this device's native push token with the API. Wrapped so any
 * failure (no permission, simulator, Expo Go, web, network) is swallowed — it
 * must never crash the app or block sign-in.
 */
export const registerDeviceToken = async ({ baseUrl, token }: Connection): Promise<void> => {
  try {
    const nativeToken = await getNativeDeviceToken()
    if (!nativeToken) {
      return
    }
    const platform: RegisterDeviceRequest['platform'] = Platform.OS === 'ios' ? 'ios' : 'android'
    const appVersion =
      typeof Constants.expoConfig?.version === 'string' ? Constants.expoConfig.version : undefined
    const body: RegisterDeviceRequest = { platform, token: nativeToken, appVersion }
    await createApiClient({ baseUrl, token }).post('/api/devices', body)
  } catch {
    // No-op: device registration is best-effort.
  }
}

/** Remove this device's token on logout. Best-effort, never throws. */
export const unregisterDeviceToken = async ({ baseUrl, token }: Connection): Promise<void> => {
  try {
    const nativeToken = await getNativeDeviceToken()
    if (!nativeToken) {
      return
    }
    await createApiClient({ baseUrl, token }).delete(`/api/devices/${encodeURIComponent(nativeToken)}`)
  } catch {
    // No-op.
  }
}
