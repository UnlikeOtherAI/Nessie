export const NATIVE_EXTERNAL_AUTH_EVENT = 'nessie:native-external-auth'

type NativeExternalAuthResult =
  | { type: 'cancelled' }
  | { message: string; type: 'failed' }
  | { type: 'success'; url: string }

type NativeExternalAuthSettlement = {
  clearPendingAuth: () => void
  setError: (message: string | null) => void
  setSubmitting: (submitting: boolean) => void
}

const parseNativeExternalAuthResult = (value: unknown): NativeExternalAuthResult | null => {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null
  }
  const result = value as { message?: unknown; type?: unknown; url?: unknown }
  if (result.type === 'cancelled') {
    return { type: 'cancelled' }
  }
  if (result.type === 'failed' && typeof result.message === 'string') {
    return { message: result.message, type: 'failed' }
  }
  if (result.type === 'success' && typeof result.url === 'string') {
    return { type: 'success', url: result.url }
  }
  return null
}

/**
 * Settle the login UI for native terminal results that do not proceed into the
 * authorization-code exchange. Successful callbacks keep the button busy and
 * continue through the existing callback URL handler.
 */
export const settleNativeExternalAuthResult = (
  value: unknown,
  settlement: NativeExternalAuthSettlement,
): 'ignored' | 'settled' | 'success' => {
  const result = parseNativeExternalAuthResult(value)
  if (!result) return 'ignored'
  if (result.type === 'success') return 'success'

  settlement.clearPendingAuth()
  settlement.setError(result.type === 'failed' ? result.message : null)
  settlement.setSubmitting(false)
  return 'settled'
}

/**
 * Subscribe the login settlement to the native bridge's terminal event. Keeping
 * the event name and detail extraction here makes the actual WebView wiring part
 * of the same tested boundary as the state transition.
 */
export const subscribeToNativeExternalAuthResults = (
  target: EventTarget,
  settlement: NativeExternalAuthSettlement,
): (() => void) => {
  const handleResult = (event: Event): void => {
    settleNativeExternalAuthResult((event as CustomEvent<unknown>).detail, settlement)
  }

  target.addEventListener(NATIVE_EXTERNAL_AUTH_EVENT, handleResult)
  return () => target.removeEventListener(NATIVE_EXTERNAL_AUTH_EVENT, handleResult)
}
