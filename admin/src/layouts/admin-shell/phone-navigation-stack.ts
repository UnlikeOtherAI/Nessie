import type { NavigationLayout } from '../../navigation/layout'
import {
  getPhoneNavigationScreen,
  getPhoneNavigationSeedChain,
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

export const STAGE_KEY_PREFIX = 'stage:'

export const isPhoneNavigationStageEntry = <Payload>(
  entry: PhoneNavigationStackEntry<Payload>,
): boolean => entry.key.startsWith(STAGE_KEY_PREFIX)

// The route entry the current position rests on: the current entry, or the
// nearest route beneath the stages stacked over it.
const routeIndexOf = <Payload>(stack: PhoneNavigationStack<Payload>): number => {
  for (let index = stack.currentIndex; index >= 0; index -= 1) {
    const entry = stack.entries[index]
    if (entry && !isPhoneNavigationStageEntry(entry)) return index
  }
  return 0
}

const requireScreen = (pathname: string, layout: NavigationLayout): PhoneNavigationScreen => {
  const screen = getPhoneNavigationScreen(pathname, layout)
  if (!screen) {
    throw new Error(`Phone navigation cannot classify ${pathname}`)
  }
  return screen
}

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

// Payload for a screen the stack seeds beneath a cold start's landing route
// (docs/navigation.md §8): the viewport renders it from the route table,
// and the route's own commit replaces it the moment the person goes there.
export type SeedPayload<Payload> = (pathname: string) => Payload

// `layout` decides how a route classifies (docs/navigation.md §5): on
// `split` roots share the floor with their details and in-parent nested
// rows collapse onto the parent, so the same reducer serves both layouts.
// With `seed`, a fresh stack (a cold start, a section change) also carries
// the registry's parent chain beneath the route as render-only entries, so
// Back and the edge swipe reveal the screens a real navigation would have.
// Nothing about them enters the ledger: Back from a seeded stage is always
// `replace`.
export const createPhoneNavigationStack = <Payload>(
  pathname: string,
  payload: Payload,
  layout: NavigationLayout = 'single',
  seed?: SeedPayload<Payload>,
): PhoneNavigationStack<Payload> => {
  const screen = requireScreen(pathname, layout)
  const landed = toStackEntry(pathname, screen, payload)
  if (!seed) return { currentIndex: 0, entries: [landed] }
  const ancestors = getPhoneNavigationSeedChain(pathname, layout)
    .reverse()
    .map((ancestor) => toStackEntry(ancestor, requireScreen(ancestor, layout), seed(ancestor)))
  return { currentIndex: ancestors.length, entries: [...ancestors, landed] }
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
//   payload under the same React layer key — a route back onto the same
//   screen may carry newer children, while the stable key preserves its DOM
//   and component state. The outgoing screen stays mounted and
//   is released by dropPhoneNavigationEntriesAboveCurrent once the Back
//   animation completes. A shallower route with no retained identity (a cold
//   deep link's Back) replaces at the target depth immediately, because
//   there is no outgoing screen to animate out.
export const advancePhoneNavigationStack = <Payload>(
  stack: PhoneNavigationStack<Payload>,
  pathname: string,
  payload: Payload,
  layout: NavigationLayout = 'single',
  seed?: SeedPayload<Payload>,
): PhoneNavigationStack<Payload> => {
  const screen = requireScreen(pathname, layout)
  // Routes compare against the route the stack rests on, never against a
  // stage stacked over it: a stage's depth is a stacking position, not a
  // place in the section's route hierarchy.
  const routeIndex = routeIndexOf(stack)
  const current = stack.entries[routeIndex]
  if (!current || screen.section !== current.section) {
    return createPhoneNavigationStack(pathname, payload, layout, seed)
  }

  const nextEntry = toStackEntry(pathname, screen, payload)

  if (screen.depth === current.depth) {
    if (current.pathname === nextEntry.pathname) {
      // The same route re-rendering (its data settled, a query param
      // changed): refresh the payload in place and keep everything above
      // it. During a Back the outgoing screen *is* the entry above the
      // current one, and dropping it here made a pop paint only the
      // returning list — the leaving screen was never in the DOM for a
      // frame (the transition suite's `phone-back` case). Siblings share
      // one layer identity by design, so the route, not the key, says
      // whether this is the same screen.
      const entries = stack.entries.slice()
      entries[routeIndex] = nextEntry
      return { ...stack, entries }
    }
    // A sibling swap (channel A → B): another route at the same depth
    // replaces the route layer and releases anything above it, its stages
    // included — they belonged to the sibling that left.
    const entries = stack.entries.slice(0, routeIndex)
    entries.push(nextEntry)
    return { currentIndex: routeIndex, entries }
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
    // A route that had stages open when it was left returns to the topmost
    // of them — the document the person was reading, not the list under it.
    let currentIndex = retainedIndex
    while (
      currentIndex + 1 < stack.currentIndex
      && isPhoneNavigationStageEntry(stack.entries[currentIndex + 1]!)
    ) currentIndex += 1
    return { ...stack, currentIndex, entries }
  }

  // No retained screen to return to: replace at the first stack position
  // holding this depth and release everything deeper — nothing below changes
  // identity, nothing above is worth animating out because it was never
  // navigated from.
  const replaceIndex = stack.entries.findIndex(
    (entry, index) => index < routeIndex && entry.depth === screen.depth,
  )
  const position = replaceIndex === -1 ? 0 : replaceIndex
  const entries = stack.entries.slice(0, position)
  entries.push(nextEntry)
  return { currentIndex: position, entries }
}

// ── Nested stages ────────────────────────────────────────────────────────
// A stage is a state-driven screen a page pushes above its own route (a
// column browser's next column, a Knowledge document, a dashboard panel).
// It is an entry like any other — same layers, same motion, same Back —
// keyed `stage:<id>`, one depth above whatever it was pushed over, and it
// carries its route's pathname so a same-route re-render still refreshes
// the route beneath it (docs/navigation.md §6).
const stageIndexOf = <Payload>(stack: PhoneNavigationStack<Payload>, id: string): number =>
  stack.entries.findIndex(
    (entry, index) => index <= stack.currentIndex && entry.key === `${STAGE_KEY_PREFIX}${id}`,
  )

export const hasPhoneNavigationStage = <Payload>(
  stack: PhoneNavigationStack<Payload>,
  id: string,
): boolean => stageIndexOf(stack, id) !== -1

// The same route re-rendering (its data settled): refresh the route entry's
// payload in place and touch nothing above it — neither a retained outgoing
// screen mid-Back nor the stages stacked over the route.
export const refreshPhoneNavigationRoute = <Payload>(
  stack: PhoneNavigationStack<Payload>,
  payload: Payload,
): PhoneNavigationStack<Payload> => {
  const index = routeIndexOf(stack)
  const entry = stack.entries[index]
  if (!entry) return stack
  const entries = stack.entries.slice()
  entries[index] = { ...entry, payload }
  return { ...stack, entries }
}

// Pushes a stage over the current entry. Re-pushing a stage that is already
// stacked is a no-op, so a page may re-assert its open stage freely.
export const pushPhoneNavigationStage = <Payload>(
  stack: PhoneNavigationStack<Payload>,
  id: string,
  payload: Payload,
): PhoneNavigationStack<Payload> => {
  if (hasPhoneNavigationStage(stack, id)) return stack
  const current = currentPhoneNavigationEntry(stack)
  const key = `${STAGE_KEY_PREFIX}${id}`
  const depth = current.depth + 1
  const entry: PhoneNavigationStackEntry<Payload> = {
    depth,
    key,
    layerKey: `${current.section}:${depth}:${key}`,
    pathname: current.pathname,
    payload,
    section: current.section,
  }
  const position = stack.currentIndex + 1
  const entries = stack.entries.slice(0, position)
  entries.push(entry)
  return { currentIndex: position, entries }
}

// Pops a stage: the entry beneath it becomes current and the stage (with
// anything stacked over it) stays retained until the Back animation
// releases it through dropPhoneNavigationEntriesAboveCurrent.
export const popPhoneNavigationStage = <Payload>(
  stack: PhoneNavigationStack<Payload>,
  id: string,
): PhoneNavigationStack<Payload> => {
  const index = stageIndexOf(stack, id)
  if (index <= 0) return stack
  return { ...stack, currentIndex: index - 1 }
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
