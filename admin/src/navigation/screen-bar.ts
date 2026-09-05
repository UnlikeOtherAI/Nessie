// What the native navigation bar shows, as one published fact per layer.
//
// The sibling of `screen.ts`, and deliberately keyed differently. A title is a
// per-pathname fact, so `screen.ts` keys by pathname and that is right for
// `document.title`. A *bar* is a per-layer fact, and the two differ in exactly
// the cases the bar has to get right:
//
//   - A nested stage never changes the pathname. An open Knowledge editor
//     still reports the space's own route, so anything keyed by pathname — or
//     derived from the registry's `screenType` — says "root" while the reader
//     is in an editor.
//   - Two screens can share one layer. `/channels/:id/info` renders the
//     channel's header *and* a full-screen overlay over it; so does a reply
//     thread. Keyed by pathname, last writer wins and the bar shows the
//     channel's title over the info screen.
//
// So: keyed by the stack's `layerKey` (`section:depth:key`), never the
// classifier's bare route `key` — a channel and its info route share that one
// while both are alive in the stack. And within a layer the publishers form a
// stack rather than a slot, so an overlay sits over its page's header and
// hands the bar back when it closes.
//
// Rulebook: docs/plans/2026-09-05-ios-native-navigation-bar.md §5.1.

import { useSyncExternalStore } from 'react'

export type ScreenBarAction = {
  checked: boolean | null
  disabled: boolean
  id: string
  items: ScreenBarMenuItem[] | null
  kind: 'button' | 'link' | 'menu' | 'toggle'
  label: string
  // What the action does, kept here rather than re-derived natively. A header
  // action is not always "call `onSelect`": a `submit` action's `onSelect` is
  // a no-op and the work happens in its form's `onSubmit`, a toggle inverts
  // its own state, and a link may have to leave through the shell. Serializing
  // enough for the native side to reconstruct any of that would be a second
  // implementation of the header's semantics; a closure is one.
  perform: (itemId?: string) => void
  primary: boolean
  priority: number
  selected: boolean
  submit: boolean
  tone: 'danger' | null
}

export type ScreenBarMenuItem = {
  checked: boolean
  disabled: boolean
  id: string
  label: string
}

export type ScreenBarBack = {
  label: string
  // The Back the header would actually run. It is not always the resolver's:
  // a Flow that owns its Back returns to an address the registry cannot know
  // (a compose's `returnTo`, a designer's edit origin), and running the
  // resolver there pops to the section root instead.
  onBack: () => void
}

export type ScreenBar = {
  actions: ScreenBarAction[]
  back: ScreenBarBack | null
  title: string
}

type Entry = {
  bar: ScreenBar
  handle: string
}

const layers = new Map<string, Entry[]>()
const fallbacks = new Map<string, ScreenBar>()
const listeners = new Set<() => void>()
let revision = 0
let currentLayerKey: string | null = null

const notify = (): void => {
  revision += 1
  for (const listener of listeners) listener()
}

/**
 * Publish this publisher's bar for a layer.
 *
 * Appended the first time the handle is seen and **updated in place**
 * afterwards, so order is mount order and stays that way. That is the whole
 * contract: order is precedence here, unlike the local-back registry where a
 * numeric priority decides and re-ordering is harmless. A publisher that
 * removed and re-appended itself on every render — which is what a plain
 * effect with changing dependencies does — would lift a re-rendering channel
 * header back over the open overlay on top of it.
 */
export const publishScreenBar = (layerKey: string, handle: string, bar: ScreenBar): void => {
  const entries = layers.get(layerKey)
  if (!entries) {
    layers.set(layerKey, [{ bar, handle }])
    notify()
    return
  }
  const existing = entries.findIndex((entry) => entry.handle === handle)
  if (existing === -1) {
    entries.push({ bar, handle })
    notify()
    return
  }
  // Always take the new descriptor, even when it looks identical: its
  // `onBack` and action callbacks are rebuilt every render and close over
  // this render's props, so keeping the old entry would leave the native bar
  // running a stale handler. Only the *notification* is conditional, or every
  // keystroke in the page beneath would post a bar message.
  const previous = entries[existing]?.bar ?? null
  entries[existing] = { bar, handle }
  if (sameScreenBar(previous, bar)) return
  notify()
}

/** Only ever called from an unmount cleanup — see `publishScreenBar`. */
export const unpublishScreenBar = (layerKey: string, handle: string): void => {
  const entries = layers.get(layerKey)
  if (!entries) return
  const next = entries.filter((entry) => entry.handle !== handle)
  if (next.length === entries.length) return
  if (next.length === 0) layers.delete(layerKey)
  else layers.set(layerKey, next)
  notify()
}

/** The topmost publisher's bar for a layer: the overlay over a page, if one is up. */
export const screenBarFor = (layerKey: string | null): ScreenBar | null => {
  if (!layerKey) return null
  const entries = layers.get(layerKey)
  if (entries && entries.length > 0) return entries[entries.length - 1]?.bar ?? null
  return fallbacks.get(layerKey) ?? null
}

/**
 * A layer's bar of last resort, used only while nothing in it has published.
 *
 * Not every screen draws a header. A nested stage may be a bare panel — the
 * dashboard's add-widget and versions panels, the executor create panel — and
 * on a phone those are full screens with a title and a way back that exist
 * only in the stack, never in the DOM. Without this they would show an empty
 * band with no way out but the edge swipe.
 *
 * It cannot be an ordinary publish: a stage's children run their effects
 * before the stage's own, so a stage publishing normally would land *on top*
 * of the header its child just published and win by mount order. A fallback is
 * read only when the layer's stack is empty, so a child that does draw a
 * header always wins.
 */
export const setLayerFallback = (layerKey: string, bar: ScreenBar | null): void => {
  const previous = fallbacks.get(layerKey) ?? null
  if (bar === null) {
    if (previous === null) return
    fallbacks.delete(layerKey)
    notify()
    return
  }
  fallbacks.set(layerKey, bar)
  if (sameScreenBar(previous, bar)) return
  notify()
}

// The viewport owns which layer is current; the bridge reads it here rather
// than re-deriving it, because `nessie:screen` carries a pathname and a
// pathname cannot name a layer.
export const publishCurrentLayerKey = (layerKey: string | null): void => {
  if (currentLayerKey === layerKey) return
  currentLayerKey = layerKey
  notify()
}

export const currentScreenLayerKey = (): string | null => currentLayerKey

const sameActions = (left: ScreenBarAction[], right: ScreenBarAction[]): boolean =>
  left.length === right.length
  && left.every((action, index) => {
    const other = right[index]
    if (!other) return false
    return action.id === other.id
      && action.label === other.label
      && action.disabled === other.disabled
      && action.primary === other.primary
      && action.priority === other.priority
      && action.selected === other.selected
      && action.submit === other.submit
      && action.tone === other.tone
      && action.kind === other.kind
      && action.checked === other.checked
      && (action.items?.length ?? -1) === (other.items?.length ?? -1)
      && (action.items ?? []).every((item, itemIndex) => {
        const otherItem = other.items?.[itemIndex]
        return otherItem !== undefined
          && item.id === otherItem.id
          && item.label === otherItem.label
          && item.disabled === otherItem.disabled
          && item.checked === otherItem.checked
      })
  })

/**
 * Field by field, ignoring handler identity: a header rebuilds its `onBack`
 * and its action callbacks on every render, and comparing those would post on
 * every keystroke in the page beneath. The handlers are still replaced — the
 * stored entry is the live one — this only decides whether anything visible
 * changed.
 */
export const sameScreenBar = (left: ScreenBar | null, right: ScreenBar | null): boolean => {
  if (left === null || right === null) return left === right
  return left.title === right.title
    && (left.back?.label ?? null) === (right.back?.label ?? null)
    && (left.back === null) === (right.back === null)
    && sameActions(left.actions, right.actions)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const snapshot = (): number => revision

/** The bar for the layer the viewport says is current. */
export const useCurrentScreenBar = (): { bar: ScreenBar | null, layerKey: string | null } => {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return { bar: screenBarFor(currentLayerKey), layerKey: currentLayerKey }
}

/** Test seam only: the store is module state shared by every publisher. */
export const resetScreenBars = (): void => {
  fallbacks.clear()
  layers.clear()
  currentLayerKey = null
  notify()
}
