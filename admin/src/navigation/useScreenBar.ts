import { useEffect, useId } from 'react'
import { publishScreenBar, unpublishScreenBar, type ScreenBar } from './screen-bar'
import { useScreenBarLayerKey } from './ScreenBarLayer'

/**
 * Publish this screen's native navigation bar for the layer it renders in.
 *
 * Two effects, deliberately:
 *
 *   - the publish runs after **every** render, with no dependency array. The
 *     store updates the entry in place and only notifies when something
 *     visible changed, so this is cheap — and it is what keeps `onBack` and
 *     the action callbacks pointing at this render's closures.
 *   - the removal runs **only on unmount**. A cleanup that fired whenever the
 *     descriptor changed would remove and re-append the entry, which in a
 *     stack where order is precedence lifts a re-rendering page header back
 *     over the full-screen overlay covering it (screen-bar.ts).
 *
 * `active` is for a publisher that is mounted but not showing — a retained
 * stage instance that does not own its stage, which must not overwrite the
 * owning instance's bar (docs/navigation/stacks-and-layout.md §6).
 */
export const useScreenBarPublisher = (bar: ScreenBar, active = true): void => {
  const layerKey = useScreenBarLayerKey()
  const handle = useId()

  useEffect(() => {
    if (!layerKey || !active) return
    publishScreenBar(layerKey, handle, bar)
  })

  useEffect(() => {
    if (!layerKey || !active) return undefined
    return () => unpublishScreenBar(layerKey, handle)
  }, [active, handle, layerKey])
}
