type TerminalPayload = { token: string }

type TerminalSessionLogoutInput = {
  currentBearer: string | null
  isNative: boolean
  logout: (bearer: string | null) => Promise<void>
  terminate: (
    finalize: (latestPayload: TerminalPayload | null) => Promise<void>,
  ) => Promise<void>
  unregisterNative: () => Promise<void>
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
    await nativeCleanup
    await logout(latestPayload?.token ?? currentBearer)
  })
}
