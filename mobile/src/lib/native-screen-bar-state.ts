import type { NativeScreenBar, NativeScreenBarTransition } from './native-shell-layout'

/**
 * What the native navigation bar is showing, and what it is moving between.
 *
 * The bar keeps a descriptor per layer rather than one "current" bar, because
 * a transition needs both ends of it. The outgoing layer's descriptor is
 * already here — it was current a moment ago — while the incoming one usually
 * is not: a forward push announces itself from the viewport's layout effect,
 * before the incoming layer has mounted, so its header publishes a render
 * later. That lane fills late; it never restarts the animation.
 *
 * A layer with no descriptor renders blank rather than falling back to the
 * root lanes, so a push can never flash a team switcher above a conversation.
 */
export type NativeScreenBarState = {
  bars: Readonly<Record<string, NativeScreenBar>>
  currentLayerKey: string | null
  transition: NativeScreenBarTransition | null
}

export const DEFAULT_NATIVE_SCREEN_BAR_STATE: NativeScreenBarState = {
  bars: {},
  currentLayerKey: null,
  transition: null,
}

export type NativeScreenBarAction =
  | { bar: NativeScreenBar, kind: 'bar' }
  | { kind: 'transition', transition: NativeScreenBarTransition }
  | { kind: 'transition-end' }

// Layers are shallow and descriptors are small, but a long session should not
// accumulate one per screen ever visited. The cap is generous enough that both
// ends of any transition, and every retained layer beneath, are always present.
const MAX_REMEMBERED_LAYERS = 16

const remember = (
  bars: Readonly<Record<string, NativeScreenBar>>,
  bar: NativeScreenBar,
  keepAlive: readonly (string | null)[],
): Record<string, NativeScreenBar> => {
  const key = bar.layerKey
  if (key === null) return { ...bars }
  const next: Record<string, NativeScreenBar> = { ...bars, [key]: bar }
  const keys = Object.keys(next)
  if (keys.length <= MAX_REMEMBERED_LAYERS) return next
  const protectedKeys = new Set([key, ...keepAlive.filter((entry): entry is string => entry !== null)])
  for (const candidate of keys) {
    if (Object.keys(next).length <= MAX_REMEMBERED_LAYERS) break
    if (protectedKeys.has(candidate)) continue
    delete next[candidate]
  }
  return next
}

export const reduceNativeScreenBar = (
  state: NativeScreenBarState,
  action: NativeScreenBarAction,
): NativeScreenBarState => {
  if (action.kind === 'transition') {
    return {
      bars: state.bars,
      // The target is current from the moment the motion starts, so the lanes
      // and the status bar settle onto the screen being travelled to rather
      // than the one being left.
      currentLayerKey: action.transition.to,
      transition: action.transition,
    }
  }
  if (action.kind === 'transition-end') {
    return state.transition === null ? state : { ...state, transition: null }
  }
  const { bar } = action
  const bars = remember(state.bars, bar, [
    state.currentLayerKey,
    state.transition?.from ?? null,
    state.transition?.to ?? null,
  ])
  // A descriptor for the layer being travelled to fills the incoming lane and
  // leaves the animation alone. Anything else is the new current screen.
  if (state.transition && bar.layerKey === state.transition.to) {
    return { ...state, bars }
  }
  return { bars, currentLayerKey: bar.layerKey, transition: state.transition }
}

export const nativeScreenBarFor = (
  state: NativeScreenBarState,
  layerKey: string | null,
): NativeScreenBar | null => (layerKey === null ? null : state.bars[layerKey] ?? null)

/** What the bar rests on: the current layer's descriptor, or nothing yet. */
export const currentNativeScreenBar = (state: NativeScreenBarState): NativeScreenBar | null =>
  nativeScreenBarFor(state, state.currentLayerKey)

/** The two ends of an in-flight transition, or null when the bar is at rest. */
export const nativeScreenBarTransitionLanes = (state: NativeScreenBarState): {
  incoming: NativeScreenBar | null
  outgoing: NativeScreenBar | null
} | null => {
  if (!state.transition) return null
  return {
    incoming: nativeScreenBarFor(state, state.transition.to),
    outgoing: nativeScreenBarFor(state, state.transition.from),
  }
}
