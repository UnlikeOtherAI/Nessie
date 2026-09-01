import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from 'react'
import { UNSAFE_LocationContext, useNavigate } from 'react-router-dom'
import {
  registerViewportMediaQuery,
  useViewport,
} from '../../hooks/useViewport'
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
  type PhoneNavigationStack,
} from './phone-navigation-stack'
import { NAV_MOTION, runStackTransition, type StackTransitionRun } from '../../navigation/motion'
import { beginStackTransition } from '../../navigation/transition-state'
import { resolveBack } from '../../navigation/back'
import { usePhoneBackSwipeGesture } from './use-phone-back-swipe'
import { useLocalBackSnapshot } from './local-back/LocalBackContext'
import { usePhoneNavigation } from './PhoneNavigationProvider'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
registerViewportMediaQuery('reducedMotion', REDUCED_MOTION_QUERY)

type PhoneNavigationViewportProps = {
  children: ReactNode
  pathname: string
}

type ScreenPayload = {
  locationContext: ContextType<typeof UNSAFE_LocationContext>
  screen: ReactNode
}

type Stack = PhoneNavigationStack<ScreenPayload>

type ActiveTransition = {
  direction: PhoneNavigationDirection
  fromLayerKey: string
  id: number
  phase: 'preparing' | 'running'
  toLayerKey: string
}

// Closes the lane if the animation's finish never arrives (a discarded
// animation, a hidden tab): the scripted duration plus slack.
const TRANSITION_FALLBACK_SLACK_MS = 100

const NavigationScreen = ({ payload }: { payload: ScreenPayload }) => (
  <UNSAFE_LocationContext.Provider value={payload.locationContext}>
    <div className="phone-navigation-page" data-phone-navigation-page>
      {payload.screen}
    </div>
  </UNSAFE_LocationContext.Provider>
)

const percent = (value: number): string => `${value.toFixed(2)}%`

// Phone route navigation owns a live DOM stack, not snapshots. Lower screens
// remain mounted and inert under the current screen, preserving scroll and
// component state. A forward push covers the immediate predecessor; Back
// slides the outgoing screen away from the retained target. Tablets never
// mount this component because AdminShellLayout keeps their columns adjacent.
export const PhoneNavigationViewport = ({
  children,
  pathname,
}: PhoneNavigationViewportProps) => {
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  // Subscribing here re-arms the gesture when an owner registers or leaves.
  useLocalBackSnapshot()
  const reducedMotion = useViewport().media?.reducedMotion ?? false
  const locationContext = useContext(UNSAFE_LocationContext)
  const viewportRef = useRef<HTMLDivElement>(null)

  const initialStack = useRef<Stack | null>(null)
  if (initialStack.current === null) {
    initialStack.current = createPhoneNavigationStack(pathname, {
      locationContext,
      screen: children,
    })
  }
  const [stack, setStack] = useState<Stack>(initialStack.current)
  const stackRef = useRef(stack)
  const [transition, setTransition] = useState<ActiveTransition | null>(null)
  const transitionRef = useRef<ActiveTransition | null>(null)
  const transitionId = useRef(0)
  // A committed interactive swipe has already animated one exact target into
  // place. Remember that pathname (rather than a loose boolean) so an
  // unrelated navigation that wins the same event turn can never have its
  // own transition suppressed.
  const suppressNextRouteAnimation = useRef<string | null>(null)

  const commitStack = useCallback((next: Stack): void => {
    stackRef.current = next
    setStack(next)
  }, [])

  const commitTransition = useCallback((next: ActiveTransition | null): void => {
    transitionRef.current = next
    setTransition(next)
  }, [])

  const finishTransition = useCallback((id: number): void => {
    if (transitionRef.current?.id !== id) return
    commitStack(dropPhoneNavigationEntriesAboveCurrent(stackRef.current))
    commitTransition(null)
  }, [commitStack, commitTransition])

  // Route children are captured only after the route commits. Until this
  // layout effect, React continues to render the previous stack unchanged;
  // a retained lower layer can therefore never receive the incoming route's
  // children for a frame.
  useLayoutEffect(() => {
    const current = stackRef.current
    const committed = committedPhoneNavigationRoute(current)
    const payload = { locationContext, screen: children }
    if (committed.pathname === pathname) {
      commitStack(advancePhoneNavigationStack(current, pathname, payload))
      return
    }

    const direction = getPhoneNavigationDirection(committed.pathname, pathname)
    let next = advancePhoneNavigationStack(current, pathname, payload)
    const suppressed = suppressNextRouteAnimation.current === pathname
    suppressNextRouteAnimation.current = null

    if (!direction || suppressed) {
      // The interactive gesture already animated a Back before changing the
      // URL. Drop its outgoing layer in the same commit so no second route
      // animation—or stale hidden detail—survives the settle.
      if (suppressed && direction === 'back') {
        next = dropPhoneNavigationEntriesAboveCurrent(next)
      }
      commitTransition(null)
      commitStack(next)
      return
    }

    const fromLayerKey = currentPhoneNavigationEntry(current).layerKey
    const toLayerKey = currentPhoneNavigationEntry(next).layerKey
    const hasBothLayers = next.entries.some((entry) => entry.layerKey === fromLayerKey)
      && next.entries.some((entry) => entry.layerKey === toLayerKey)
    commitStack(next)
    if (!hasBothLayers) {
      commitTransition(null)
      return
    }
    transitionId.current += 1
    commitTransition({
      direction,
      fromLayerKey,
      id: transitionId.current,
      // Back already has two painted, retained screens. A forward push has
      // just mounted its destination, so hold it offscreen until the browser
      // has painted that DOM once before starting either transform.
      phase: direction === 'forward' && !reducedMotion ? 'preparing' : 'running',
      toLayerKey,
    })
  }, [
    children,
    commitStack,
    commitTransition,
    locationContext,
    pathname,
    reducedMotion,
  ])

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
        const current = transitionRef.current
        if (current?.id !== transition.id || current.phase !== 'preparing') return
        commitTransition({ ...current, phase: 'running' })
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
    const run: StackTransitionRun = runStackTransition({
      top: layer(forward ? 'incoming' : 'outgoing'),
      bottom: layer(forward ? 'outgoing' : 'incoming'),
      direction: transition.direction,
      reducedMotion,
    })
    const id = transition.id
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
      window.clearTimeout(timer)
      run.cancel()
      endTransition()
    }
  }, [finishTransition, reducedMotion, transition])

  // The finger settles first; only its completion changes the route. That
  // route commit is marked as already animated, preventing a second keyframe.
  // The swipe drives the retained route layers, so it arms only when the one
  // resolver answers with a route Back: an in-page owner (a column, a
  // knowledge stage) is not a layer yet and would close in place under a
  // slide that revealed the wrong screen. Owners join the gesture when they
  // become nested stages (docs/navigation.md).
  const routeBackAction = navigation?.resolveBackAction(pathname) ?? null
  const gestureArmed = routeBackAction?.kind === 'route'

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
    // newly mounted owner consume the swipe and leave the route suppression
    // marker attached to the wrong future navigation.
    const action = navigation.resolveBackAction(pathname)
    if (action?.kind !== 'route') return
    suppressNextRouteAnimation.current = action.to
    navigation.performBackAction(action)
  }, [finishTransition, navigate, navigation, pathname])

  const gesture = usePhoneBackSwipeGesture({
    enabled: stack.currentIndex > 0 && transition === null && gestureArmed,
    onCommit: performGestureBack,
    reducedMotion,
    viewportRef,
  })

  const gestureTopTravel = gesture.progress === null
    ? null
    : percent(gesture.progress * 100)
  const gestureUnderlayTravel = gesture.progress === null
    ? null
    : percent(-(1 - gesture.progress) * NAV_MOTION.parallax * 100)

  const renderLayer = (index: number) => {
    const entry = stack.entries[index]
    if (!entry) return null

    const isCurrent = index === stack.currentIndex
    const isImmediateLower = index === stack.currentIndex - 1
    const isTop = transition
      ? entry.layerKey === (
          transition.direction === 'forward'
            ? transition.toLayerKey
            : transition.fromLayerKey
        )
      : isCurrent
    const isBottom = transition
      ? entry.layerKey === (
          transition.direction === 'forward'
            ? transition.fromLayerKey
            : transition.toLayerKey
        )
      : isImmediateLower
    const hidden = !isTop && !isBottom
    const layerName = isTop
      ? transition
        ? transition.direction === 'forward' ? 'incoming' : 'outgoing'
        : 'current'
      : isBottom
        ? transition
          ? transition.direction === 'forward' ? 'outgoing' : 'incoming'
          : 'underlay'
        : 'retained'
    const inertLayer = isBottom || Boolean(transition && isTop)
    const classes = ['phone-navigation-screen']
    let style: React.CSSProperties | undefined

    if (isTop) {
      if (transition) {
        classes.push(
          transition.direction === 'forward'
            ? transition.phase === 'preparing'
              ? 'phone-navigation-screen--forward-ready'
              : 'phone-navigation-screen--forward-in'
            : 'phone-navigation-screen--back-out',
        )
      } else {
        classes.push('phone-navigation-screen--current')
        if (gestureTopTravel !== null && stack.currentIndex > 0) {
          style = {
            boxShadow: 'var(--nav-shadow)',
            transform: `translate3d(${gestureTopTravel}, 0, 0)`,
          }
        }
      }
    } else if (isBottom) {
      if (transition) {
        classes.push(
          transition.direction === 'forward'
            ? transition.phase === 'preparing'
              ? 'phone-navigation-screen--forward-source-ready'
              : 'phone-navigation-screen--forward-out'
            : 'phone-navigation-screen--back-in',
        )
      } else {
        classes.push('phone-navigation-screen--underlay')
        if (gestureUnderlayTravel !== null) {
          style = { transform: `translate3d(${gestureUnderlayTravel}, 0, 0)` }
        }
      }
    }

    return (
      <div
        aria-hidden={inertLayer || hidden ? true : undefined}
        className={classes.join(' ')}
        data-phone-navigation-layer={layerName}
        data-phone-navigation-route={entry.key}
        hidden={hidden || undefined}
        inert={inertLayer || undefined}
        key={entry.layerKey}
        style={style}
      >
        <NavigationScreen payload={entry.payload} />
      </div>
    )
  }

  return (
    <div
      className="phone-navigation-viewport"
      data-phone-navigation-direction={transition?.direction}
      data-phone-navigation-gesture={gesture.settle ? 'settling' : 'idle'}
      data-phone-navigation-phase={transition?.phase}
      data-phone-navigation-viewport
      ref={viewportRef}
    >
      {stack.entries.map((_, index) => renderLayer(index))}
    </div>
  )
}
