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
import { useMediaQuery } from '../../hooks/useMediaQuery'
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
import { usePhoneBackSwipeGesture } from './use-phone-back-swipe'
import { PHONE_BACK_SWIPE_UNDERLAY_TRAVEL } from './phone-navigation-gesture'

type PhoneNavigationViewportProps = {
  children: ReactNode
  pathname: string
}

// What a retained screen holds: the exact rendered subtree and router
// location the route committed with. Lower layers never receive a later
// route's children — their payload is captured once and only ever dropped.
type ScreenPayload = {
  locationContext: ContextType<typeof UNSAFE_LocationContext>
  screen: ReactNode
}

type Stack = PhoneNavigationStack<ScreenPayload>

type ActiveTransition = {
  direction: PhoneNavigationDirection
  id: number
}

const TRANSITION_FALLBACK_MS = 400
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

const NavigationScreen = ({ payload }: { payload: ScreenPayload }) => (
  <UNSAFE_LocationContext.Provider value={payload.locationContext}>
    {payload.screen}
  </UNSAFE_LocationContext.Provider>
)

const percent = (value: number): string => `${value.toFixed(2)}%`

// Owns the phone's stacked navigation, including the interactive edge
// back-swipe. Every committed route's screen is captured into the stack
// reducer and rendered in a stable keyed layer; a forward push slides the
// new screen over the live lower layers, Back returns to the exact retained
// screen it left (scroll and state intact — never a rebuilt subtree), and a
// committed swipe settles its own motion before the route updates, so no
// keyframe ever replays over a gesture. Tablets never mount this viewport,
// so multi-column layouts are untouched.
export const PhoneNavigationViewport = ({
  children,
  pathname,
}: PhoneNavigationViewportProps) => {
  const navigate = useNavigate()
  const locationContext = useContext(UNSAFE_LocationContext)
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY)
  const viewportRef = useRef<HTMLDivElement>(null)

  const [stack, setStack] = useState<Stack>(() =>
    createPhoneNavigationStack(pathname, { locationContext, screen: children }),
  )
  const [transition, setTransition] = useState<ActiveTransition | null>(null)
  const transitionId = useRef(0)
  const suppressNextRouteAnimation = useRef(false)

  // A pending route renders the previous stack untouched until the layout
  // effect advances it, so a lower layer never sees new children and a
  // render pass can never rebuild a retained screen.
  useLayoutEffect(() => {
    setStack((current) => {
      const committed = committedPhoneNavigationRoute(current)
      if (committed.pathname === pathname) {
        // Same route re-render: refresh only the current layer's payload.
        // Layers above it (a Back's outgoing screen mid-animation) keep the
        // subtree they were captured with.
        return advancePhoneNavigationStack(
          current,
          committed.pathname,
          { locationContext, screen: children },
        )
      }

      const direction = getPhoneNavigationDirection(committed.pathname, pathname)
      const next = advancePhoneNavigationStack(current, pathname, {
        locationContext,
        screen: children,
      })
      if (!direction || suppressNextRouteAnimation.current) {
        suppressNextRouteAnimation.current = false
        setTransition(null)
        return next
      }
      transitionId.current += 1
      setTransition({ direction, id: transitionId.current })
      return next
    })
  }, [pathname, children, locationContext])

  useEffect(() => {
    if (!transition) return undefined
    const timer = window.setTimeout(() => {
      setStack(dropPhoneNavigationEntriesAboveCurrent)
      setTransition((current) =>
        current?.id === transition.id ? null : current,
      )
    }, TRANSITION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [transition])

  const finishTransition = useCallback(() => {
    setStack(dropPhoneNavigationEntriesAboveCurrent)
    setTransition((current) =>
      current?.id === transitionId.current ? null : current,
    )
  }, [])

  const currentEntry = currentPhoneNavigationEntry(stack)

  // The gesture's commit seam: fired only after the commit settle completes,
  // performing the single route update — the same deterministic parent-path
  // destination the shared Back button navigates to. finishTransition drops
  // a superseded route animation so the commit lands on a clean layer pair,
  // and the suppression flag keeps exactly the next route animation from
  // replaying after a settle that already moved both layers.
  const onBack = useCallback(() => {
    finishTransition()
    suppressNextRouteAnimation.current = true
    const target = getPhoneNavigationBackTarget(pathname)
    if (target) navigate(target.pathname)
  }, [finishTransition, navigate, pathname])

  const gesture = usePhoneBackSwipeGesture({
    enabled: stack.currentIndex > 0 && transition === null,
    onCommit: onBack,
    reducedMotion,
    viewportRef,
  })

  const gestureDetailTravel =
    gesture.progress === null ? null : percent(gesture.progress * 100)
  const gestureUnderlayTravel = gesture.progress === null
    ? null
    : percent(-(1 - gesture.progress) * PHONE_BACK_SWIPE_UNDERLAY_TRAVEL * 100)

  const renderLayer = (index: number) => {
    const entry = stack.entries[index]
    if (!entry) return null

    const isCurrent = index === stack.currentIndex
    const isAbove = index > stack.currentIndex
    const isImmediateLower = index === stack.currentIndex - 1

    // The visible lane's two layers: the arriving screen ("top") and the one
    // it is revealing or covering ("bottom"). With no route transition the
    // lane is the current screen over its live underlay; during a forward
    // push the top is the new screen and the bottom the one it slides over;
    // during Back the top is the outgoing screen retained above the target
    // it reveals. Every other retained layer is hidden and inert.
    const isTop = transition
      ? transition.direction === 'forward'
        ? isCurrent
        : isAbove
      : isCurrent
    const isBottom = transition
      ? transition.direction === 'forward'
        ? index === stack.currentIndex - 1
        : isCurrent
      : isImmediateLower
    const layerName = isTop
      ? transition && transition.direction === 'forward'
        ? 'incoming'
        : transition
          ? 'outgoing'
          : 'current'
      : isBottom
        ? transition
          ? transition.direction === 'forward'
            ? 'outgoing'
            : 'incoming'
          : 'underlay'
        : 'retained'
    const hidden = !isTop && !isBottom
    const inertLayer = isBottom || (Boolean(transition) && transition.direction === 'back' && isTop)

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
        if (gestureDetailTravel !== null && stack.currentIndex > 0) {
          style = {
            boxShadow: '-12px 0 32px var(--scrim)',
            transform: `translate3d(${gestureDetailTravel}, 0, 0)`,
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
          if (event.currentTarget !== event.target) return
          if (isTop || (isBottom && transition?.direction === 'back')) {
            finishTransition()
          }
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
