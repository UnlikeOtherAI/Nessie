import { useCallback, useEffect } from 'react'
import { useBlocker, type Blocker } from 'react-router-dom'

/**
 * Asks before the reader walks away from work that is still in flight.
 *
 * Two exits, guarded together:
 *
 * - **The browser's own** — reload, back, closing the tab — through
 *   `beforeunload`, which is registered *only* while `active` is true and torn
 *   down the moment it is not. A handler left behind would put the browser's
 *   confirmation in front of ordinary navigation forever.
 * - **In-app navigation**, through the data router's `useBlocker`. The admin
 *   mounts `createBrowserRouter`, so this is the router's supported seam and
 *   needs no interception of clicks or history. Only a change of path blocks;
 *   a search-param change (the same screen re-filtering itself) does not.
 *
 * The caller renders the confirmation for a `blocked` blocker and decides what
 * `proceed()` and `reset()` mean. When the work finishes while the reader is
 * still deciding, the block resolves itself — there is nothing left to warn
 * about.
 */
export const useLeaveGuard = (active: boolean): Blocker => {
  useEffect(() => {
    if (!active) {
      return
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Legacy browsers ignore preventDefault and read this instead. The string
      // is never shown: browsers render their own wording.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active])

  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        active && currentLocation.pathname !== nextLocation.pathname,
      [active],
    ),
  )

  useEffect(() => {
    if (!active && blocker.state === 'blocked') {
      blocker.proceed()
    }
  }, [active, blocker])

  return blocker
}
