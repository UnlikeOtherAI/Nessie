import { useCallback } from 'react'
import { useLocation, useNavigate, type NavigateFunction, type To } from 'react-router-dom'
import { whenStackSettled } from './transition-state'

// A redirect is a navigation the person did not ask for: data arrived (the
// first channel, the first status), a session resolved, an intent param was
// consumed. It always replaces, always forwards state, and never starts a
// second slide under a running one — it waits for the stack to settle, and
// it is dropped if the location moved on while it waited. Every effect that
// used to call navigate(..., { replace: true }) calls this instead.
//
// Rulebook: docs/navigation.md §4.

export type RedirectTarget = To

export type RedirectOptions = { state?: unknown }

export const deferredRedirect = (
  navigate: NavigateFunction,
  keyAtCall: string,
  currentKey: () => string,
  to: RedirectTarget,
  options?: RedirectOptions,
): void => {
  void whenStackSettled().then(() => {
    if (currentKey() !== keyAtCall) return
    void navigate(to, { replace: true, state: options?.state ?? null })
  })
}

export const useRedirect = (): ((to: RedirectTarget, options?: RedirectOptions) => void) => {
  const navigate = useNavigate()
  const location = useLocation()
  const key = location.key
  return useCallback(
    (to: RedirectTarget, options?: RedirectOptions) => {
      // The key captured at call time is compared against the key the
      // router reports when the wait ends; a navigation in between wins.
      deferredRedirect(navigate, key, () => latestKey.current, to, options)
    },
    [key, navigate],
  )
}

// The router's latest key, kept outside React so a deferred redirect that
// outlives a render can still compare against it.
const latestKey = { current: 'default' }

export const useTrackLocationKey = (): void => {
  const location = useLocation()
  latestKey.current = location.key
}
