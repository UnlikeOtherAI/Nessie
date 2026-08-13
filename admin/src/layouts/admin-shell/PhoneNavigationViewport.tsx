import {
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from 'react'
import { UNSAFE_LocationContext } from 'react-router-dom'
import {
  getPhoneNavigationDirection,
  getPhoneNavigationScreen,
  type PhoneNavigationDirection,
} from './phone-navigation-transition'

type PhoneNavigationViewportProps = {
  children: ReactNode
  pathname: string
}

type NavigationEntry = {
  id: string
  locationContext: ContextType<typeof UNSAFE_LocationContext>
  pathname: string
  screen: ReactNode
}

type ActiveTransition = {
  direction: PhoneNavigationDirection
  id: number
  outgoing: NavigationEntry
}

const TRANSITION_FALLBACK_MS = 400

const getScreenId = (pathname: string): string =>
  getPhoneNavigationScreen(pathname)?.key ?? `route:${pathname}`

const NavigationScreen = ({
  entry,
}: {
  entry: NavigationEntry
}) => (
  <UNSAFE_LocationContext.Provider value={entry.locationContext}>
    {entry.screen}
  </UNSAFE_LocationContext.Provider>
)

// Owns the phone's list/detail page swap. The outgoing route stays mounted for
// one animation so its live DOM can leave with the incoming screen rather than
// disappearing before the next frame. Tablets never mount this viewport: the
// shell keeps their navigation and detail columns visible side by side.
export const PhoneNavigationViewport = ({
  children,
  pathname,
}: PhoneNavigationViewportProps) => {
  const locationContext = useContext(UNSAFE_LocationContext)
  const nextEntry: NavigationEntry = {
    id: getScreenId(pathname),
    locationContext,
    pathname,
    screen: children,
  }
  const [transition, setTransition] = useState<ActiveTransition | null>(null)
  const [, commitRoute] = useReducer((version: number) => version + 1, 0)
  const latestEntry = useRef(nextEntry)
  const transitionId = useRef(0)

  if (latestEntry.current.id === nextEntry.id) {
    latestEntry.current = nextEntry
  }

  useLayoutEffect(() => {
    const outgoing = latestEntry.current
    if (outgoing.id === nextEntry.id) return

    const direction = getPhoneNavigationDirection(
      outgoing.pathname,
      nextEntry.pathname,
    )
    latestEntry.current = nextEntry
    commitRoute()
    if (!direction) {
      setTransition(null)
      return
    }

    transitionId.current += 1
    setTransition({
      direction,
      id: transitionId.current,
      outgoing,
    })
  }, [nextEntry.id])

  useEffect(() => {
    if (!transition) return undefined
    const timer = window.setTimeout(() => {
      setTransition((current) => current?.id === transition.id ? null : current)
    }, TRANSITION_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [transition])

  // A changed screen id is committed in the layout effect before paint. Until
  // then, keep the prior route on screen and suppress any superseded animation.
  const awaitingRouteCommit = latestEntry.current.id !== nextEntry.id
  const currentEntry = awaitingRouteCommit ? latestEntry.current : nextEntry
  const activeTransition = awaitingRouteCommit ? null : transition

  if (!activeTransition) {
    return (
      <div className="phone-navigation-viewport" data-phone-navigation-viewport>
        <div
          className="phone-navigation-screen phone-navigation-screen--current"
          data-phone-navigation-layer="current"
          data-phone-navigation-route={currentEntry.id}
          key={currentEntry.id}
        >
          <NavigationScreen entry={currentEntry} />
        </div>
      </div>
    )
  }

  const finishTransition = () => {
    setTransition((current) => current?.id === activeTransition.id ? null : current)
  }

  return (
    <div
      className="phone-navigation-viewport"
      data-phone-navigation-direction={activeTransition.direction}
      data-phone-navigation-viewport
    >
      <div
        aria-hidden="true"
        className={[
          'phone-navigation-screen',
          `phone-navigation-screen--${activeTransition.direction}-out`,
        ].join(' ')}
        data-phone-navigation-layer="outgoing"
        data-phone-navigation-route={activeTransition.outgoing.id}
        inert
        key={activeTransition.outgoing.id}
      >
        <NavigationScreen entry={activeTransition.outgoing} />
      </div>
      <div
        className={[
          'phone-navigation-screen',
          `phone-navigation-screen--${activeTransition.direction}-in`,
        ].join(' ')}
        data-phone-navigation-layer="incoming"
        data-phone-navigation-route={currentEntry.id}
        key={currentEntry.id}
        onAnimationEnd={(event) => {
          if (event.currentTarget === event.target) finishTransition()
        }}
      >
        <NavigationScreen entry={currentEntry} />
      </div>
    </div>
  )
}
