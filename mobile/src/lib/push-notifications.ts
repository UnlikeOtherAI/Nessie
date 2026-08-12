import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import type { DevicePushToken } from 'expo-notifications'
import { Platform } from 'react-native'
import { pathFromPushData, type PushData } from './push-navigation'

export type NativePushRegistration = {
  platform: 'ios' | 'android'
  token: string
  appVersion?: string
  apnsEnvironment?: 'sandbox' | 'production'
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

const nativePlatform = (): NativePushRegistration['platform'] | null => {
  if (Platform.OS === 'ios') return 'ios'
  if (Platform.OS === 'android') return 'android'
  return null
}

const configureAndroidPushChannel = async (): Promise<void> => {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('nessie-messages', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    showBadge: true,
    vibrationPattern: [0, 250, 250, 250],
  })
}

const appVersion = (): string | undefined => {
  const version = Constants.expoConfig?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

const isPushData = (data: unknown): data is PushData =>
  typeof data === 'object' && data !== null && !Array.isArray(data)

const pathFromResponse = (response: Notifications.NotificationResponse): string | null => {
  const data = response.notification.request.content.data
  return isPushData(data) ? pathFromPushData(data) : null
}

const registrationFromDeviceToken = async (
  deviceToken: DevicePushToken,
): Promise<NativePushRegistration | null> => {
  if (deviceToken.type !== 'ios' && deviceToken.type !== 'android') return null
  if (typeof deviceToken.data !== 'string' || deviceToken.data.length === 0) return null

  const nativeApnsEnvironment = deviceToken.type === 'ios'
    ? await Application.getIosPushNotificationServiceEnvironmentAsync()
    : null
  return {
    platform: deviceToken.type,
    token: deviceToken.data,
    appVersion: appVersion(),
    ...(nativeApnsEnvironment === 'development' || nativeApnsEnvironment === 'production'
      ? { apnsEnvironment: nativeApnsEnvironment === 'development' ? 'sandbox' : 'production' }
      : {}),
  }
}

/**
 * Requests notification permission and returns the raw APNs/FCM device token.
 * Nessie sends directly to APNs/FCM, so this deliberately never requests an
 * Expo Push token.
 */
export const getNativePushRegistration = async (): Promise<NativePushRegistration | null> => {
  const platform = nativePlatform()
  if (!platform) return null

  await configureAndroidPushChannel()

  let permissions = await Notifications.getPermissionsAsync()
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync()
  }
  if (!permissions.granted) return null

  return registrationFromDeviceToken(await Notifications.getDevicePushTokenAsync())
}

/** Registers a rolled APNs/FCM token before the old installation token dies. */
export const subscribeToPushTokenChanges = (
  onRegistration: (registration: NativePushRegistration) => void,
): (() => void) => {
  const subscription = Notifications.addPushTokenListener((deviceToken) => {
    void registrationFromDeviceToken(deviceToken)
      .then((registration) => {
        if (registration) onRegistration(registration)
      })
      .catch(() => undefined)
  })
  return () => subscription.remove()
}

/** Native presentation only; the API remains the authoritative attention state. */
export const reconcileNativeAttentionPresentation = async (total: number): Promise<void> => {
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(Math.max(0, Math.floor(total)))
  }
}

/** Clear cards once the user is actively looking at Nessie, never durable state. */
export const dismissNativeNotificationCards = async (): Promise<void> => {
  await Notifications.dismissAllNotificationsAsync()
}

/**
 * Claims the notification which launched the process before the WebView is
 * created. The response persists in Expo until cleared, so consume it exactly
 * once instead of reopening an old conversation on a later app launch.
 */
export const takeInitialPushNavigationPath = async (): Promise<string | null> => {
  const response = await Notifications.getLastNotificationResponseAsync()
  if (!response) return null

  const path = pathFromResponse(response)
  await Notifications.clearLastNotificationResponseAsync().catch(() => undefined)
  return path
}

/**
 * Delivers foreground notification taps to the WebView shell as internal SPA
 * paths. Cold starts use takeInitialPushNavigationPath before WebView creation.
 * The native app never sees an authenticated Nessie token.
 */
export const subscribeToPushNavigation = (
  navigate: (path: string) => void,
): (() => void) => {
  const handleResponse = (response: Notifications.NotificationResponse): void => {
    const path = pathFromResponse(response)
    if (path) navigate(path)
  }

  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse)

  return () => {
    subscription.remove()
  }
}
