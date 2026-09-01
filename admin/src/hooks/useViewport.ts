import { useSyncExternalStore } from 'react'

// The singleton viewport store from docs/plans/2026-08-13-responsive-coherence.md §B.
// One MediaQueryList per named minimum breakpoint, with the numeric values read from
// the `--breakpoint-*` custom properties emitted by the `@theme static` block in
// styles.css — the stylesheet stays the sole numeric source; TS never restates a
// pixel value. Bands derive from minimum queries only: "below md" is `!atLeast.md`,
// never a separately typed `max-width` literal (which is what left the 767/768 gaps).

export const BREAKPOINT_NAMES = ['sm', 'md', 'lg', 'xl', '2xl'] as const
export type BreakpointName = (typeof BREAKPOINT_NAMES)[number]
export type ViewportBand = 'base' | BreakpointName

export type ViewportCapabilities = {
  hover: boolean
  coarsePointer: boolean
}

export type ViewportSnapshot = {
  band: ViewportBand
  atLeast: Record<BreakpointName, boolean>
  capabilities: ViewportCapabilities
  // Named one-off media queries layered onto the band scale for facts the band
  // scale cannot express (e.g. a two-dimensional tablet gate or reduced motion).
  // Absent on the server snapshot; a browser snapshot only carries entries for
  // queries registered before that snapshot was read.
  media?: Record<string, boolean>
}

export type BreakpointThresholds = Record<BreakpointName, number>

export const deriveBand = (atLeast: Record<BreakpointName, boolean>): ViewportBand => {
  let band: ViewportBand = 'base'
  for (const name of BREAKPOINT_NAMES) {
    if (atLeast[name]) band = name
  }
  return band
}

// Pure snapshot derivation, exported for tests: the store below is this logic fed by
// live MediaQueryLists. `readMinimum(name)` reports whether the viewport is at or
// above that breakpoint's minimum width.
export const deriveSnapshot = (
  readMinimum: (name: BreakpointName) => boolean,
  capabilities: ViewportCapabilities,
  media: Record<string, boolean> = {},
): ViewportSnapshot => {
  const atLeast = {} as Record<BreakpointName, boolean>
  for (const name of BREAKPOINT_NAMES) {
    atLeast[name] = readMinimum(name)
  }
  return { band: deriveBand(atLeast), atLeast, capabilities, media }
}

// Exported for tests so the parsing contract (px and rem, root font size 16) is
// asserted directly.
export const parseCssLengthToPx = (raw: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(raw.trim())
  if (!match) return null
  const value = Number.parseFloat(match[1] as string)
  return match[2] === 'rem' ? value * 16 : value
}

export const readBreakpointThresholds = (
  readToken: (name: string) => string,
): BreakpointThresholds | null => {
  const thresholds = {} as Record<BreakpointName, number>
  for (const name of BREAKPOINT_NAMES) {
    const px = parseCssLengthToPx(readToken(`--breakpoint-${name}`))
    if (px === null) return null
    thresholds[name] = px
  }
  return thresholds
}

const minimumWidthQuery = (px: number): string => `(min-width: ${px}px)`

// Only `hover: hover` means a precise pointer that can hover; only `pointer: coarse`
// means the primary pointer is touch-class. Width is never a proxy for either (D3).
const HOVER_QUERY = '(hover: hover)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'

const SERVER_SNAPSHOT: ViewportSnapshot = {
  band: 'base',
  atLeast: { sm: false, md: false, lg: false, xl: false, '2xl': false },
  capabilities: { hover: false, coarsePointer: false },
}

type ViewportStore = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ViewportSnapshot
  getServerSnapshot: () => ViewportSnapshot
  registerMediaQuery: (name: string, query: string) => void
}

const mediaEqual = (
  a: Record<string, boolean> | undefined,
  b: Record<string, boolean> | undefined,
): boolean => {
  const aKeys = Object.keys(a ?? {})
  const bKeys = Object.keys(b ?? {})
  return aKeys.length === bKeys.length && aKeys.every((key) => a?.[key] === b?.[key])
}

const snapshotsEqual = (a: ViewportSnapshot, b: ViewportSnapshot): boolean =>
  a.band === b.band &&
  BREAKPOINT_NAMES.every((name) => a.atLeast[name] === b.atLeast[name]) &&
  a.capabilities.hover === b.capabilities.hover &&
  a.capabilities.coarsePointer === b.capabilities.coarsePointer &&
  mediaEqual(a.media, b.media)

const createViewportStore = (thresholds: BreakpointThresholds): ViewportStore => {
  type WatchedQuery = { mql: MediaQueryList; read: () => boolean }
  const watch = (query: string): WatchedQuery => {
    const mql = window.matchMedia(query)
    return { mql, read: () => mql.matches }
  }
  const namedMediaQueries = new Map<string, WatchedQuery>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const watchLane = (query: string): WatchedQuery => {
    const lane = watch(query)
    lane.mql.addEventListener('change', notify)
    return lane
  }

  const minimumQueries = BREAKPOINT_NAMES.map(
    (name) => [name, watchLane(minimumWidthQuery(thresholds[name]))] as const,
  )
  const hover = watchLane(HOVER_QUERY)
  const coarsePointer = watchLane(COARSE_POINTER_QUERY)

  const readSnapshot = (): ViewportSnapshot => {
    const media: Record<string, boolean> = {}
    for (const [name, query] of namedMediaQueries) {
      media[name] = query.read()
    }
    return deriveSnapshot(
      (name) => minimumQueries.find(([key]) => key === name)?.[1].read() ?? false,
      { hover: hover.read(), coarsePointer: coarsePointer.read() },
      media,
    )
  }

  let snapshot = readSnapshot()

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // Identity changes only when a value changes, which is what keeps
    // useSyncExternalStore from re-rendering on every notification.
    getSnapshot: () => {
      const next = readSnapshot()
      if (!snapshotsEqual(snapshot, next)) snapshot = next
      return snapshot
    },
    getServerSnapshot: () => SERVER_SNAPSHOT,
    // Registering a lane re-reads the snapshot so the next getSnapshot() call
    // already carries the new entry, then notifies so subscribers re-read.
    registerMediaQuery: (name, query) => {
      if (!namedMediaQueries.has(name)) {
        namedMediaQueries.set(name, watchLane(query))
      }
      snapshot = readSnapshot()
      notify()
    },
  }
}

const createBrowserViewportStore = (): ViewportStore => {
  const readToken = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name)
  const thresholds = readBreakpointThresholds(readToken)
  if (thresholds === null) {
    // Fail loud in dev: a missing token means styles.css lost its @theme block and
    // every band would silently derive as 'base'. Production degrades to the base
    // snapshot instead of throwing mid-render.
    if (import.meta.env.DEV) {
      const missing =
        BREAKPOINT_NAMES.find(
          (name) => parseCssLengthToPx(readToken(`--breakpoint-${name}`)) === null,
        ) ?? BREAKPOINT_NAMES[0]
      throw new Error(
        `useViewport: styles.css is missing the --breakpoint-${missing} theme token. ` +
          'The @theme static breakpoint block is the sole numeric source for viewport ' +
          'breakpoints — restore it (docs/plans/2026-08-13-responsive-coherence.md §A).',
      )
    }
    return serverStore
  }
  return createViewportStore(thresholds)
}

const serverStore: ViewportStore = {
  subscribe: () => () => {},
  getSnapshot: () => SERVER_SNAPSHOT,
  getServerSnapshot: () => SERVER_SNAPSHOT,
  registerMediaQuery: () => {},
}

// SSR / non-DOM contexts (tests without a window) see the base snapshot.
// The browser store is created lazily on first use, NOT at module init: in
// dev, Vite injects styles.css into the document after the import graph
// evaluates, so the emitted --breakpoint-* tokens are only readable once the
// first component renders. Reading them at import time threw the fail-loud
// dev error on every page load.
let lazyStore: ViewportStore | null = null
// Registrations arriving before first use (module-level callers like
// lib/mobile-shell.ts) are buffered so they never force store creation at
// import time; they replay onto the real store when it is first created.
const pendingQueries: Array<[string, string]> = []
const resolveStore = (): ViewportStore => {
  if (lazyStore === null) {
    lazyStore = typeof window === 'undefined' ? serverStore : createBrowserViewportStore()
    for (const [name, query] of pendingQueries.splice(0)) {
      lazyStore.registerMediaQuery(name, query)
    }
  }
  return lazyStore
}

export const useViewport = (): ViewportSnapshot => {
  const store = resolveStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

// Named one-off media queries for facts the band scale cannot express. The name
// is registered once per store; the lane value is undefined until the browser
// store has read it, so consumers must treat `undefined` as false (server
// render / pre-registration render).
export const registerViewportMediaQuery = (name: string, query: string): void => {
  if (lazyStore === null) {
    pendingQueries.push([name, query])
    return
  }
  lazyStore.registerMediaQuery(name, query)
}
