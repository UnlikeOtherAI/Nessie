import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { UNSAFE_LocationContext, useNavigate } from 'react-router-dom'
import {
  getPhoneNavigationDirection,
  type PhoneNavigationDirection,
} from './phone-navigation'
import {
  advancePhoneNavigationStack,
  committedPhoneNavigationRoute,
  createPhoneNavigationStack,
  currentPhoneNavigationEntry,
  dropPhoneNavigationEntriesAboveCurrent,
  hasPhoneNavigationStage,
  isPhoneNavigationStageEntry,
  popPhoneNavigationStage,
  pushPhoneNavigationStage,
  refreshPhoneNavigationRoute,
  type PhoneNavigationStack,
} from './phone-navigation-stack'
import { runStackTransition, type StackTransitionRun } from '../../navigation/motion'
import { beginStackTransition } from '../../navigation/transition-state'
import { useReducedMotion } from '../../navigation/reduced-motion'
import type { NavigationLayout } from '../../navigation/layout'
import { NestedStageHostContext, type NestedStageHost } from '../../navigation/NestedStage'
import { haptic } from '../../lib/haptics'
import { announceScreen, blurBeforePush, layerHoldsFocus, settleFocus } from '../../navigation/settle'
import { resolveBack } from '../../navigation/back'
import { usePhoneBackSwipeGesture } from './use-phone-back-swipe'
import { useLocalBackSnapshot } from './local-back/LocalBackContext'
import { usePhoneNavigation } from './PhoneNavigationProvider'
import {
  PhoneNavigationLayer,
  type LayerPayload,
  type LayerRole,
} from './PhoneNavigationLayer'

type PhoneNavigationViewportProps = {
  children: ReactNode
  // `single` is the one stack over the whole content region; `split` is
  // the stack inside a pinned list column's detail area, where the root is
  // the column itself, in-parent nested rows swap in place, and no edge
  // swipe arms (the column has no edge of its own; docs/navigation/overview.md §5).
  layout?: NavigationLayout
  pathname: string
  // Renders a screen the stack seeds beneath a cold start's landing route
  // (docs/navigation/overview.md §8): the shell supplies the section's list for a
  // root and the route table's page for anything else.
  seed?: (pathname: string) => ReactNode
}

type Stack = PhoneNavigationStack<LayerPayload>

type ActiveTransition = {
  direction: PhoneNavigationDirection
  fromLayerKey: string
  id: number
  // Whether the leaving screen held focus when the transition began; the
  // settle reads it to decide where focus lands (docs/navigation/overview.md §12).
  outgoingHadFocus: boolean
  phase: 'preparing' | 'running'
  toLayerKey: string
}

// Closes the lane if the animation's finish never arrives (a discarded
// animation, a hidden tab): the scripted duration plus slack.
const TRANSITION_FALLBACK_SLACK_MS = 100

// The navigation stack. Route screens and nested stages are one retained DOM
// stack: lower layers stay mounted and inert under the current one,
// preserving scroll and component state. A forward push covers the
// immediate predecessor; Back slides the outgoing layer away from the
// retained target; the edge swipe drives the same two layers with the
// finger. One instance covers a phone's whole content region; on a split
// layout one sits in each detail column (docs/navigation/overview.md §4–§6).
export const PhoneNavigationViewport = ({
  children,
  layout = 'single',
  pathname,
  seed,
}: PhoneNavigationViewportProps) => {
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  // Subscribing here re-arms the gesture when an owner registers or leaves.
  useLocalBackSnapshot()
  const reducedMotion = useReducedMotion()
  const locationContext = useContext(UNSAFE_LocationContext)
  const viewportRef = useRef<HTMLDivElement>(null)

  const seedRef = useRef(seed)
  seedRef.current = seed
  const seedPayload = useCallback((seededPathname: string): LayerPayload => ({
    kind: 'seeded',
    pathname: seededPathname,
    screen: seedRef.current?.(seededPathname) ?? null,
  }), [])
  const seedEntries = seed ? seedPayload : undefined

  const initialStack = useRef<Stack | null>(null)
  if (initialStack.current === null) {
    initialStack.current = createPhoneNavigationStack(pathname, {
      kind: 'screen',
      locationContext,
      screen: children,
    }, layout, seedEntries)
  }
  const [stack, setStack] = useState<Stack>(initialStack.current)
  const stackRef = useRef(stack)
  const [transition, setTransition] = useState<ActiveTransition | null>(null)
  const transitionRef = useRef<ActiveTransition | null>(null)
  const transitionId = useRef(0)
  // A committed interactive swipe has already animated one exact target into
  // place. Remember that pathname (rather than a loose boolean) so an
  // unrelated navigation that wins the same event turn can never have its
  // own transition suppressed. Stages get the same marker by id.
  const suppressNextRouteAnimation = useRef<string | null>(null)
  const suppressNextStageAnimation = useRef<string | null>(null)

  const commitStack = useCallback((next: Stack): void => {
    stackRef.current = next
    setStack(next)
  }, [])

  const commitTransition = useCallback((next: ActiveTransition | null): void => {
    transitionRef.current = next
    setTransition(next)
  }, [])

  const finishTransition = useCallback((id: number): void => {
    const finished = transitionRef.current
    if (finished?.id !== id) return
    commitStack(dropPhoneNavigationEntriesAboveCurrent(stackRef.current))
    commitTransition(null)
    // The settle: focus and announce the screen that has landed, never
    // mid-slide. The DOM still carries the transition's layer names here,
    // and the landing layer is "incoming" for a push and a pop alike.
    const top = viewportRef.current?.querySelector('[data-phone-navigation-layer="incoming"]') ?? null
    settleFocus({ direction: finished.direction, top, outgoingHadFocus: finished.outgoingHadFocus })
    announceScreen(top)
  }, [commitStack, commitTransition])

  const startTransition = useCallback((
    direction: PhoneNavigationDirection,
    fromLayerKey: string,
    toLayerKey: string,
  ): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    // The DOM still shows the pre-transition pose: the screen that is about
    // to leave (a pop) or be covered (a push) is the current layer.
    const outgoing = viewportRef.current?.querySelector('[data-phone-navigation-layer="current"]') ?? null
    const outgoingHadFocus = layerHoldsFocus(outgoing, active)
    // A push closes the soft keyboard on purpose, not as a side effect of
    // the outgoing layer becoming inert.
    if (direction === 'forward') blurBeforePush(active)
    transitionId.current += 1
    commitTransition({
      direction,
      fromLayerKey,
      id: transitionId.current,
      outgoingHadFocus,
      // Back already has two painted, retained screens. A forward push has
      // just mounted its destination, so hold it offscreen until the browser
      // has painted that DOM once before starting either transform.
      phase: direction === 'forward' && !reducedMotion ? 'preparing' : 'running',
      toLayerKey,
    })
  }, [commitTransition, reducedMotion])

  // Route children are captured only after the route commits. Until this
  // layout effect, React continues to render the previous stack unchanged;
  // a retained lower layer can therefore never receive the incoming route's
  // children for a frame.
  useLayoutEffect(() => {
    const current = stackRef.current
    const committed = committedPhoneNavigationRoute(current)
    const payload: LayerPayload = { kind: 'screen', locationContext, screen: children }
    if (committed.pathname === pathname) {
      commitStack(refreshPhoneNavigationRoute(current, payload))
      return
    }

    // A navigation arriving mid-slide settles the running transition first
    // (its end pose commits, its released entries drop, its settle runs), so
    // the new one starts from a clean stack instead of preempting a half-
    // finished pose (docs/navigation/overview.md §13).
    const running = transitionRef.current
    if (running) finishTransition(running.id)
    const base = stackRef.current
    const direction = getPhoneNavigationDirection(committed.pathname, pathname, layout)
    let next = advancePhoneNavigationStack(base, pathname, payload, layout, seedEntries)
    const suppressed = suppressNextRouteAnimation.current === pathname
    suppressNextRouteAnimation.current = null

    if (!direction || suppressed) {
      // Nothing will animate, so nothing above the new current entry will
      // ever be shown again: an interactive swipe already animated its Back,
      // and an in-place swap has no outgoing screen.
      next = dropPhoneNavigationEntriesAboveCurrent(next)
      commitTransition(null)
      commitStack(next)
      return
    }

    const fromLayerKey = currentPhoneNavigationEntry(base).layerKey
    const toLayerKey = currentPhoneNavigationEntry(next).layerKey
    const hasBothLayers = next.entries.some((entry) => entry.layerKey === fromLayerKey)
      && next.entries.some((entry) => entry.layerKey === toLayerKey)
    commitStack(next)
    if (!hasBothLayers) {
      commitTransition(null)
      return
    }
    startTransition(direction, fromLayerKey, toLayerKey)
  }, [
    children,
    commitStack,
    commitTransition,
    finishTransition,
    layout,
    locationContext,
    pathname,
    seedEntries,
    startTransition,
  ])

  // Nested stages join the same stack (docs/navigation/overview.md §6): activation
  // pushes a layer over the current entry and runs the forward motion;
  // deactivation makes the entry beneath current and runs Back, unless the
  // edge swipe already animated it. Only a single-column layout hosts
  // stages; a split layout's pages compose their stages inline.
  const activateStage = useCallback((id: string, container: HTMLElement): void => {
    const running = transitionRef.current
    if (running) finishTransition(running.id)
    const current = stackRef.current
    const next = pushPhoneNavigationStage(current, id, { kind: 'stage', container })
    if (next === current) return
    const fromLayerKey = currentPhoneNavigationEntry(current).layerKey
    commitStack(next)
    startTransition('forward', fromLayerKey, currentPhoneNavigationEntry(next).layerKey)
  }, [commitStack, finishTransition, startTransition])

  const deactivateStage = useCallback((id: string, options: { animate: boolean }): void => {
    if (!hasPhoneNavigationStage(stackRef.current, id)) return
    const running = transitionRef.current
    if (running) finishTransition(running.id)
    const current = stackRef.current
    const suppressed = suppressNextStageAnimation.current === id
    suppressNextStageAnimation.current = null
    const outgoing = currentPhoneNavigationEntry(current)
    const next = popPhoneNavigationStage(current, id)
    if (next === current) return
    const isTop = outgoing.key === `stage:${id}`
    if (!options.animate || suppressed || !isTop) {
      commitTransition(null)
      commitStack(dropPhoneNavigationEntriesAboveCurrent(next))
      return
    }
    commitStack(next)
    startTransition('back', outgoing.layerKey, currentPhoneNavigationEntry(next).layerKey)
  }, [commitStack, commitTransition, finishTransition, startTransition])

  const stageIds = useMemo(
    () => stack.entries
      .filter((entry, index) => index <= stack.currentIndex && isPhoneNavigationStageEntry(entry))
      .map((entry) => entry.key.slice('stage:'.length)),
    [stack],
  )
  const retainedIds = useMemo(
    () => stack.entries
      .filter((entry) => isPhoneNavigationStageEntry(entry))
      .map((entry) => entry.key.slice('stage:'.length)),
    [stack],
  )
  const stageHost = useMemo<NestedStageHost | null>(
    () => (layout === 'single'
      ? { activate: activateStage, deactivate: deactivateStage, retainedIds, stageIds }
      : null),
    [activateStage, deactivateStage, layout, retainedIds, stageIds],
  )

  useEffect(() => {
    if (
      !transition
      || transition.direction !== 'forward'
      || transition.phase !== 'preparing'
    ) return undefined

    // rAF callbacks run before paint. The first boundary lets the prepared
    // offscreen layer reach the compositor; changing classes in the second
    // starts motion only after that prepared state has actually been painted.
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (transitionRef.current?.id !== transition.id) return
        commitTransition({ ...transition, phase: 'running' })
      })
    })

    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== 0) cancelAnimationFrame(secondFrame)
    }
  }, [commitTransition, transition])

  // The running phase is the one scripted motion: both layers animate on the
  // Web Animations API from their static poses to the end poses that the
  // finishing classes then hold. Cleanup runs when the transition state
  // changes — in React's commit, before paint — so the static end pose is
  // already painted when the animation's fill is released, and nothing jumps.
  useLayoutEffect(() => {
    if (!transition || transition.phase !== 'running') return undefined
    const viewport = viewportRef.current
    const layer = (name: string): Element | null =>
      viewport?.querySelector(`[data-phone-navigation-layer="${name}"]`) ?? null
    const forward = transition.direction === 'forward'
    // A hidden document paints nothing: the slide commits at once, so a
    // tab that comes back is already settled rather than mid-animation.
    const hidden = document.visibilityState === 'hidden'
    const run: StackTransitionRun = runStackTransition({
      top: layer(forward ? 'incoming' : 'outgoing'),
      bottom: layer(forward ? 'outgoing' : 'incoming'),
      direction: transition.direction,
      reducedMotion: reducedMotion || hidden,
    })
    const id = transition.id
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') finishTransition(id)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    // Anything that must not run mid-slide (a data-arrival redirect, focus
    // after settle) waits on this signal; it ends with the transition.
    const endTransition = beginStackTransition()
    let closed = false
    void run.finished.then(() => {
      if (!closed) finishTransition(id)
    })
    const timer = window.setTimeout(
      () => finishTransition(id),
      run.durationMs + TRANSITION_FALLBACK_SLACK_MS,
    )
    return () => {
      closed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearTimeout(timer)
      run.cancel()
      endTransition()
    }
  }, [finishTransition, reducedMotion, transition])

  // The finger settles first; only its completion changes the route or
  // closes the stage. The swipe drives the retained layers, so it arms when
  // the one resolver answers with a route Back, or with an owner that is the
  // stage on top of this stack and allows the gesture.
  const backAction = navigation?.resolveBackAction(pathname) ?? null
  const topEntry = currentPhoneNavigationEntry(stack)
  const gestureArmed = backAction?.kind === 'route'
    || (backAction?.kind === 'owner' && backAction.swipeable && topEntry.key === backAction.id)

  const performGestureBack = useCallback(() => {
    const activeTransition = transitionRef.current
    if (activeTransition) finishTransition(activeTransition.id)
    if (!navigation) {
      // Outside the controller (isolated tests) fall back to the parent.
      const action = resolveBack({ pathname, owners: null, ledger: null })
      if (action?.kind !== 'route') return
      suppressNextRouteAnimation.current = action.to
      void navigate(action.to)
      return
    }
    // Resolve while the gesture is still armed, then execute that immutable
    // action. Re-resolving through performBack after the settle could let a
    // newly mounted owner consume the swipe and leave the suppression marker
    // attached to the wrong future navigation.
    const action = navigation.resolveBackAction(pathname)
    if (!action) return
    if (action.kind === 'owner') {
      suppressNextStageAnimation.current = action.id.slice('stage:'.length)
    } else {
      suppressNextRouteAnimation.current = action.to
    }
    // The one haptic of a Back: the swipe has settled and the route is about
    // to change. A cancelled swipe and a tapped Back give none.
    haptic('light')
    navigation.performBackAction(action)
  }, [finishTransition, navigate, navigation, pathname])

  const gesture = usePhoneBackSwipeGesture({
    enabled: layout === 'single' && stack.currentIndex > 0 && transition === null && gestureArmed,
    onCommit: performGestureBack,
    reducedMotion,
    viewportRef,
  })

  const roleOf = (index: number): LayerRole => {
    const entry = stack.entries[index]!
    if (transition) {
      const forward = transition.direction === 'forward'
      if (entry.layerKey === (forward ? transition.toLayerKey : transition.fromLayerKey)) return 'top'
      if (entry.layerKey === (forward ? transition.fromLayerKey : transition.toLayerKey)) return 'bottom'
      return 'hidden'
    }
    if (index === stack.currentIndex) return 'top'
    if (index === stack.currentIndex - 1) return 'bottom'
    return 'hidden'
  }

  return (
    <NestedStageHostContext.Provider value={stageHost}>
      <div
        className="phone-navigation-viewport"
        data-phone-navigation-direction={transition?.direction}
        data-phone-navigation-gesture={gesture.settle ? 'settling' : 'idle'}
        data-phone-navigation-phase={transition?.phase}
        data-phone-navigation-viewport
        ref={viewportRef}
      >
        {stack.entries.map((entry, index) => (
          <PhoneNavigationLayer
            entry={entry}
            gestureProgress={gesture.progress}
            hasUnderlay={stack.currentIndex > 0}
            key={entry.layerKey}
            role={roleOf(index)}
            transition={transition}
          />
        ))}
      </div>
    </NestedStageHostContext.Provider>
  )
}
