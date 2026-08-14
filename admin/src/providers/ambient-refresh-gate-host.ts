import {
  blockAmbientRefresh,
  isAmbientRefreshBlocked,
  unblockAmbientRefresh,
} from './ambient-refresh-gate'

// The provider-side host wiring for the terminal ambient-refresh gate: one
// ref per mounted provider, initialized from the persisted marker, plus the
// coordinator hooks that set it. Kept outside AuthSessionProvider so the
// provider stays under its line cap and the gate lifecycle lives in one
// cohesive module.
export type AmbientRefreshGateHost = {
  /** Synchronous in-memory gate, exact even before a React commit. */
  ref: { current: boolean }
  /**
   * Coordinator `onTerminalStart`: persists the marker and sets the ref the
   * instant a logout or foreign fence BEGINS — before any awaited DELETE or
   * revocation — so a page/Tauri/WebView remount during that pending work
   * still starts fenced.
   */
  onTerminalStart: () => void
  /**
   * Coordinator `onTerminal`: the post-clear notification. The gate is
   * already set by `onTerminalStart`; nothing further to do here.
   */
  onTerminal: () => void
  /** Reads the ref at call time for the coordinator's ambient facades. */
  isBlocked: () => boolean
  /**
   * Clears ref and marker after a successfully APPLIED explicit login,
   * bootstrap, dev login, or validated explicit recovery.
   */
  reopen: () => void
}

export const createAmbientRefreshGateHost = (): AmbientRefreshGateHost => {
  const ref = { current: isAmbientRefreshBlocked() }
  return {
    ref,
    onTerminalStart: () => {
      // Persist FIRST, synchronously: the marker is the cross-remount fence.
      blockAmbientRefresh()
      ref.current = true
    },
    onTerminal: () => undefined,
    isBlocked: () => ref.current,
    reopen: () => {
      ref.current = false
      unblockAmbientRefresh()
    },
  }
}
