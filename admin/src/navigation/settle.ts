// What the stack does once a slide has landed (docs/navigation/overview.md §12):
// move focus and announce the screen — never mid-slide, and never by
// scrolling a clipped container.

export type SettleFocusSpec = {
  direction: 'forward' | 'back'
  // The layer that is now current.
  top: Element | null
  // Whether the screen that left held focus when the transition began. A
  // pop moves focus only then: a person tabbing through the retained list
  // must not lose their place because a detail above it closed.
  outgoingHadFocus: boolean
}

const headingOf = (layer: Element | null): HTMLElement | null =>
  layer?.querySelector<HTMLElement>('h1') ?? null

// A push focuses the new screen's heading; a pop focuses the retained
// screen's heading only if the popped screen held focus. Both use
// `preventScroll`, because a focus that scrolls is how the bounce was made.
export const settleFocus = ({ direction, top, outgoingHadFocus }: SettleFocusSpec): boolean => {
  if (direction === 'back' && !outgoingHadFocus) return false
  const heading = headingOf(top)
  if (!heading) return false
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  heading.focus({ preventScroll: true })
  return true
}

export const layerHoldsFocus = (layer: Element | null, active: Element | null): boolean =>
  Boolean(layer && active && layer.contains(active))

// Before a push the active element is blurred explicitly, so a composer's
// soft keyboard closes as the screen leaves rather than because the outgoing
// layer happened to become inert.
export const blurBeforePush = (active: Element | null): void => {
  if (active instanceof HTMLElement && active !== document.body) active.blur()
}

export const ANNOUNCER_ATTRIBUTE = 'data-navigation-announcer'

const ANNOUNCE_DEBOUNCE_MS = 150
let announceTimer: ReturnType<typeof setTimeout> | null = null

// The one polite live region announces the settled screen's heading. Two
// settles inside the debounce announce once, with the later title; an
// overlay announces through its own dialog semantics instead, never both.
export const announceScreen = (top: Element | null, root: ParentNode = document): void => {
  const title = headingOf(top)?.textContent?.trim()
  if (!title) return
  if (announceTimer) clearTimeout(announceTimer)
  announceTimer = setTimeout(() => {
    announceTimer = null
    const region = root.querySelector(`[${ANNOUNCER_ATTRIBUTE}]`)
    if (region) region.textContent = title
  }, ANNOUNCE_DEBOUNCE_MS)
}
