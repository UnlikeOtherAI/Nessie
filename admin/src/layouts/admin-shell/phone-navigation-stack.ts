import {
  getPhoneNavigationScreen,
  type PhoneNavigationScreen,
} from './phone-navigation'

// The pure half of the phone navigation stack. The viewport owns React and
// DOM; this module owns which screens exist and which one is current, so the
// retention policy is testable without a browser. Entries carry whatever
// payload the viewport captured for a route (its rendered subtree and router
// location context) — the reducer never inspects it.
export type PhoneNavigationStackEntry<Payload> = {
  depth: number
  key: string
  // Layer identity across the whole stack. The classifier's route key can
  // repeat at different depths (e.g. a channel's screen and its own tab
  // route share one key), so identity is section+depth+key and React layer
  // keys use it — never the bare route key.
  layerKey: string
  pathname: string
  payload: Payload
  section: string
}

export type PhoneNavigationStack<Payload> = {
  // One stack position per entry, shallowest first. Positions are never
  // assumed to equal depths: a cold deep link seeds a single entry whose
  // depth is greater than its position, and Back from it lands on position
  // 0 — so every operation here reads and writes stack positions, never
  // indexes by absolute depth.
  entries: Array<PhoneNavigationStackEntry<Payload>>
  // Position of the screen the route is currently on. During a Back this
  // points at the retained lower entry immediately, so the stack renders
  // both the target (as current) and the outgoing screen (still retained
  // above it) for the duration of the animation.
  currentIndex: number
}

type CommittedRoute = {
  depth: number
  key: string
  pathname: string
  section: string
}

const layerIdentity = (screen: PhoneNavigationScreen): string =>
  `${screen.section}:${screen.depth}:${screen.key}`

const toStackEntry = <Payload>(
  pathname: string,
  screen: PhoneNavigationScreen,
  payload: Payload,
): PhoneNavigationStackEntry<Payload> => ({
  layerKey: layerIdentity(screen),
  payload,
  pathname,
  ...screen,
})

const toCommittedRoute = <Payload>(
  entry: PhoneNavigationStackEntry<Payload>,
): CommittedRoute => ({
  depth: entry.depth,
  key: entry.key,
  pathname: entry.pathname,
  section: entry.section,
})

export const createPhoneNavigationStack = <Payload>(
  pathname: string,
  payload: Payload,
): PhoneNavigationStack<Payload> => {
  const screen = getPhoneNavigationScreen(pathname)
  return { currentIndex: 0, entries: [toStackEntry(pathname, screen, payload)] }
}

// Advances the stack to a committed route. Never rebuilds a lower entry's
// payload: once a screen is captured it is only ever dropped, never
// recreated from a later route's children.
//
// - Cross-section routes reset to a single fresh entry.
// - A deeper same-section route drops any entries at or above its depth,
//   then appends — lower entries keep their exact payloads, so a forward
//   push cannot recreate the list it slides over.
// - A route at the current depth updates the current layer's key and payload
//   in place and drops anything retained above it. No animation: the layer
//   identity is unchanged.
// - A shallower same-section route that matches a retained entry's layer
//   identity moves the current marker down and refreshes that target's
//   payload in place — a route back onto the same screen may carry newer
//   children, and updating the already-mounted layer preserves its DOM and
//   state while never recreating it. The outgoing screen stays mounted and
//   is released by dropPhoneNavigationEntriesAboveCurrent once the Back
//   animation completes. A shallower route with no retained identity (a cold
//   deep link's Back) replaces at the target depth immediately, because
//   there is no outgoing screen to animate out.
export const advancePhoneNavigationStack = <Payload>(
  stack: PhoneNavigationStack<Payload>,
  pathname: string,
  payload: Payload,
): PhoneNavigationStack<Payload> => {
  const screen = getPhoneNavigationScreen(pathname)
  const current = stack.entries[stack.currentIndex]
  if (!current || screen.section !== current.section) {
    return createPhoneNavigationStack(pathname, payload)
  }

  const nextEntry = toStackEntry(pathname, screen, payload)

  if (screen.depth === current.depth) {
    const entries = stack.entries.slice(0, stack.currentIndex)
    entries.push(nextEntry)
    return { currentIndex: stack.currentIndex, entries }
  }

  if (screen.depth > current.depth) {
    // Append at the next stack position — the depth tells us where this
    // screen sits in the section, but positions are compact and a retained
    // entry at or above this depth is replaced by the new route's capture.
    const position = stack.currentIndex + 1
    const entries = stack.entries.slice(0, position)
    entries.push(nextEntry)
    return { currentIndex: position, entries }
  }

  // Shallower: search by layer identity across the retained lower entries,
  // never by an absolute depth index — position and depth only coincide for
  // a stack grown one screen at a time from a root.
  const retainedIndex = stack.entries.findIndex(
    (entry, index) => index < stack.currentIndex
      && entry.layerKey === nextEntry.layerKey,
  )
  if (retainedIndex !== -1) {
    const entries = stack.entries.slice()
    entries[retainedIndex] = nextEntry
    return { ...stack, currentIndex: retainedIndex, entries }
  }

  // No retained screen to return to: replace at the first stack position
  // holding this depth and release everything deeper — nothing below changes
  // identity, nothing above is worth animating out because it was never
  // navigated from.
  const replaceIndex = stack.entries.findIndex(
    (entry, index) => index < stack.currentIndex && entry.depth === screen.depth,
  )
  const position = replaceIndex === -1 ? 0 : replaceIndex
  const entries = stack.entries.slice(0, position)
  entries.push(nextEntry)
  return { currentIndex: position, entries }
}

// Releases the screens a completed Back animation slid away. The outgoing
// payload is never read again after this — the entry it animated out of is
// gone, so a later forward push re-renders that depth from its own route.
export const dropPhoneNavigationEntriesAboveCurrent = <Payload>(
  stack: PhoneNavigationStack<Payload>,
): PhoneNavigationStack<Payload> => {
  const entries = stack.entries.slice(0, stack.currentIndex + 1)
  return entries.length === stack.entries.length
    ? stack
    : { ...stack, entries }
}

export const currentPhoneNavigationEntry = <Payload>(
  stack: PhoneNavigationStack<Payload>,
): PhoneNavigationStackEntry<Payload> => {
  const entry = stack.entries[stack.currentIndex]
  if (!entry) throw new Error('phone navigation stack has no current entry')
  return entry
}

export const committedPhoneNavigationRoute = <Payload>(
  stack: PhoneNavigationStack<Payload>,
): CommittedRoute => toCommittedRoute(currentPhoneNavigationEntry(stack))
