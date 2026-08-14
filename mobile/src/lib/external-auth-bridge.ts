export type NativeExternalAuthResult =
  | { type: 'cancelled' }
  | { message: string; type: 'failed' }
  | { type: 'success'; url: string }

type BrowserAuthSessionResult = {
  type: string
  url?: string
}

type OpenAuthSession = (
  authorizeUrl: string,
  callbackUrl: string,
) => Promise<BrowserAuthSessionResult>

export const NATIVE_EXTERNAL_AUTH_EVENT = 'nessie:native-external-auth'

const FAILED_TO_OPEN_MESSAGE = 'Unable to open the sign-in window. Please try again.'

/**
 * Normalize every browser-session terminal path before it crosses into the
 * hosted WebView. Closing the iOS authentication sheet is an ordinary cancel,
 * while locked/invalid native sessions and thrown failures are actionable.
 */
export const runExternalAuthSession = async (
  authorizeUrl: string,
  callbackUrl: string,
  openAuthSession: OpenAuthSession,
): Promise<NativeExternalAuthResult> => {
  try {
    const result = await openAuthSession(authorizeUrl, callbackUrl)
    if (result.type === 'success' && typeof result.url === 'string') {
      return { type: 'success', url: result.url }
    }
    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { type: 'cancelled' }
    }
    return { message: FAILED_TO_OPEN_MESSAGE, type: 'failed' }
  } catch {
    return { message: FAILED_TO_OPEN_MESSAGE, type: 'failed' }
  }
}

/**
 * Publish the terminal result to the SPA. The success callback remains for
 * compatibility with desktop/native callback routing; the completion event is
 * what releases UI state on cancellation or native failure.
 */
export const nativeExternalAuthResultScript = (result: NativeExternalAuthResult): string => {
  const payload = JSON.stringify(result)
  const successCallback = result.type === 'success'
    ? `
try {
  if (typeof window.__nessieExternalAuthCallback === 'function') {
    window.__nessieExternalAuthCallback(${JSON.stringify(result.url)});
  }
} catch (e) {}`
    : ''

  return `
try {
  window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_EXTERNAL_AUTH_EVENT)}, {
    detail: ${payload},
  }));
} catch (e) {}
${successCallback}
`
}
