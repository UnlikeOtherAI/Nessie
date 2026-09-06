/**
 * How many full-bleed layers are covering the document right now.
 *
 * The native shells draw their own chrome *over* the WebView from geometry
 * the web publishes — the iPad's creation control is placed on the list
 * column reported by `nessie:list-column`. Native chrome cannot see a web
 * overlay, so a modal that covers the whole viewport left the `+` floating on
 * top of it: over the full-screen browser it was a button for a column that
 * was no longer on screen, and pressing it acted on a surface the reader
 * could not see.
 *
 * A count rather than a flag because overlays nest — a dialog opened from
 * inside the full-screen browser must not un-suspend the chrome when it
 * closes. Module state is right here: this describes the one document, and
 * there is exactly one of those per WebView.
 */

let openLayers = 0
const listeners = new Set<(suspended: boolean) => void>()

const publish = (): void => {
  const suspended = openLayers > 0
  for (const listener of listeners) listener(suspended)
}

/** True while at least one full-bleed layer is up. */
export const nativeChromeSuspended = (): boolean => openLayers > 0

/**
 * Register a layer for as long as it is open. Returns the retraction, so the
 * caller can hand it straight back from a `useEffect`.
 */
export const holdNativeChromeSuspended = (): (() => void) => {
  openLayers += 1
  publish()
  let released = false
  return () => {
    if (released) return
    released = true
    openLayers -= 1
    publish()
  }
}

export const subscribeNativeChromeSuspended = (
  listener: (suspended: boolean) => void,
): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
