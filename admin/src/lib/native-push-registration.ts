import {
  RegisterDeviceRequestSchema,
  type RegisterDeviceRequest,
} from '@nessie/schemas'

export const NATIVE_PUSH_TOKEN_EVENT = 'nessie:native-push-token'
export const NATIVE_PUSH_UNREGISTER_EVENT = 'nessie:native-push-unregister'

/**
 * Reads only the structural native-token payload injected by the React Native
 * shell. The API client remains in the authenticated WebView, so a native
 * process never receives the browser access token.
 */
export const readNativePushRegistration = (event: Event): RegisterDeviceRequest | null => {
  const result = RegisterDeviceRequestSchema.safeParse(
    (event as CustomEvent<unknown>).detail,
  )
  return result.success ? result.data : null
}
