type TerminalPayload = { token: string }

// Native bridge events normally settle immediately. Keep the remote session
// revocation independent from a bridge that never sends its completion event.
export const NATIVE_CLEANUP_LOGOUT_TIMEOUT_MS = 1_000

type TerminalSessionLogoutInput = {
  currentBearer: string | null
  isNative: boolean
  logout: (bearer: string | null) => Promise<void>
  terminate: (
    finalize: (latestPayload: TerminalPayload | null) => Promise<void>,
  ) => Promise<void>
  unregisterNative: () => Promise<void>
}

const waitForNativeCleanup = (nativeCleanup: Promise<void> | null): Promise<void> => {
  if (!nativeCleanup) return Promise.resolve()

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, NATIVE_CLEANUP_LOGOUT_TIMEOUT_MS)
    void nativeCleanup.then(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

/**
 * Starts native cleanup while the authenticated bridge is still mounted, then
 * begins terminal session clearing without waiting for that cleanup. Remote
 * logout remains the final step and is bound to the winning session payload.
 */
export const performTerminalSessionLogout = ({
  currentBearer,
  isNative,
  logout,
  terminate,
  unregisterNative,
}: TerminalSessionLogoutInput): Promise<void> => {
  let nativeCleanup: Promise<void> | null = null
  if (isNative) {
    try {
      nativeCleanup = unregisterNative().catch(() => undefined)
    } catch {
      nativeCleanup = Promise.resolve()
    }
  }

  return terminate(async (latestPayload) => {
    await waitForNativeCleanup(nativeCleanup)
    await logout(latestPayload?.token ?? currentBearer)
  })
}
