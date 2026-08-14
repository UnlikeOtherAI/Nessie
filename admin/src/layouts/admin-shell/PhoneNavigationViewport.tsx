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
  getPhoneNavigationBackTarget,
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
import { PHONE_BACK_SWIPE_UNDERLAY_TRAVEL } from './phone-navigation-gesture'
import { usePhoneBackSwipeGesture } from './use-phone-back-swipe'
import { useLocalBackSnapshot } from './local-back/LocalBackContext'
import { usePhoneNavigation } from './PhoneNavigationProvider'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
registerViewportMediaQuery('reducedMotion', REDUCED_MOTION_QUERY)

type PhoneNavigationViewportProps = {
  children: ReactNode
  onBack?: () => void
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
  toLayerKey: string
}

const TRANSITION_FALLBACK_MS = 400

const NavigationScreen = ({ payload }: { payload: ScreenPayload }) => (
  <UNSAFE_LocationContext.Provider value={payload.locationContext}>
    {payload.screen}
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
  onBack,
  pathname,
}: PhoneNavigationViewportProps) => {
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  const localBackActive = Boolean(useLocalBackSnapshot()?.active)
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
  const suppressNextRouteAnimation = useRef(false)

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
    const suppressed = suppressNextRouteAnimation.current
    suppressNextRouteAnimation.current = false

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
      toLayerKey,
    })
  }, [children, commitStack, commitTransition, locationContext, pathname])

  useEffect(() => {
    if (!transition) return undefined
    const timer = window.setTimeout(
      () => finishTransition(transition.id),
      TRANSITION_FALLBACK_MS,
    )
    return () => window.clearTimeout(timer)
  }, [finishTransition, transition])

  // The finger settles first; only its completion changes the route. That
  // route commit is marked as already animated, preventing a second keyframe.
  const performGestureBack = useCallback(() => {
    const activeTransition = transitionRef.current
    if (activeTransition) finishTransition(activeTransition.id)
    suppressNextRouteAnimation.current = true
    if (onBack) {
      onBack()
      return
    }
    if (navigation) {
      navigation.performBack()
      return
    }
    const target = getPhoneNavigationBackTarget(pathname)
    if (target) void navigate(target.pathname)
  }, [finishTransition, navigate, navigation, onBack, pathname])

  const gesture = usePhoneBackSwipeGesture({
    enabled: stack.currentIndex > 0 && transition === null && !localBackActive,
    onCommit: performGestureBack,
    reducedMotion,
    viewportRef,
  })

  const gestureTopTravel = gesture.progress === null
    ? null
    : percent(gesture.progress * 100)
  const gestureUnderlayTravel = gesture.progress === null
    ? null
    : percent(-(1 - gesture.progress) * PHONE_BACK_SWIPE_UNDERLAY_TRAVEL * 100)

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
            ? 'phone-navigation-screen--forward-in'
            : 'phone-navigation-screen--back-out',
        )
      } else {
        classes.push('phone-navigation-screen--current')
        if (gestureTopTravel !== null && stack.currentIndex > 0) {
          style = {
            boxShadow: '-12px 0 32px var(--scrim)',
            transform: `translate3d(${gestureTopTravel}, 0, 0)`,
          }
        }
      }
    } else if (isBottom) {
      if (transition) {
        classes.push(
          transition.direction === 'forward'
            ? 'phone-navigation-screen--forward-out'
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
        onAnimationEnd={(event) => {
          if (event.currentTarget !== event.target || !transition || !isTop) return
          finishTransition(transition.id)
        }}
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
      data-phone-navigation-viewport
      ref={viewportRef}
    >
      {stack.entries.map((_, index) => renderLayer(index))}
    </div>
  )
}
