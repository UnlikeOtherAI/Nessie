import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * The Home Screen icon: the light default or the dark alternative.
 *
 * iOS-only. `requireOptionalNativeModule` makes "unavailable" a readable state
 * on Android, in Expo Go, and in an installed build that predates the module,
 * so the admin only offers the choice where it can take effect.
 */

export type AppIconVariant = 'light' | 'dark'

type NessieAppIconNativeModule = {
  isSupported: () => boolean
  getIcon: () => AppIconVariant
  setIcon: (icon: AppIconVariant) => Promise<AppIconVariant>
}

const nativeModule = requireOptionalNativeModule<NessieAppIconNativeModule>('NessieAppIcon')

export const isAppIconSwitchAvailable = (): boolean => nativeModule?.isSupported() === true

export const getAppIcon = (): AppIconVariant => nativeModule?.getIcon() ?? 'light'

export const setAppIcon = async (icon: AppIconVariant): Promise<AppIconVariant> => {
  if (!nativeModule) throw new Error('Changing the app icon is not available in this build.')
  return nativeModule.setIcon(icon)
}
