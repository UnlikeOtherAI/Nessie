import { UNSAFE_LocationContext } from 'react-router-dom'
import type { ContextType, CSSProperties, ReactNode } from 'react'
import { dimAt, NAV_MOTION } from '../../navigation/motion'
import type { PhoneNavigationDirection } from './phone-navigation'
import type { PhoneNavigationStackEntry } from './phone-navigation-stack'

// What a layer holds: a route's captured subtree, or a nested stage's
// container that its page fills through a portal.
export type ScreenPayload = {
  kind: 'screen'
  locationContext: ContextType<typeof UNSAFE_LocationContext>
  screen: ReactNode
}

export type StagePayload = {
  kind: 'stage'
  container: HTMLElement
}

export type LayerPayload = ScreenPayload | StagePayload

export type LayerTransition = {
  direction: PhoneNavigationDirection
  phase: 'preparing' | 'running'
}

// The retained stack renders every entry in a stable keyed sibling; only the
// top and bottom of the current pose or transition are visible.
export type LayerRole = 'top' | 'bottom' | 'hidden'

type PhoneNavigationLayerProps = {
  entry: PhoneNavigationStackEntry<LayerPayload>
  // The finger's live displacement (0..1) during an edge swipe, else null.
  gestureProgress: number | null
  role: LayerRole
  // True when the top layer has something beneath it to reveal.
  hasUnderlay: boolean
  transition: LayerTransition | null
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`

const StageMount = ({ container }: { container: HTMLElement }) => (
  <div
    ref={(node) => {
      if (node && container.parentNode !== node) node.appendChild(container)
    }}
    style={{ display: 'contents' }}
  />
)

const NavigationScreen = ({ payload }: { payload: LayerPayload }) =>
  payload.kind === 'stage' ? (
    <StageMount container={payload.container} />
  ) : (
    <UNSAFE_LocationContext.Provider value={payload.locationContext}>
      <div className="phone-navigation-page" data-phone-navigation-page>
        {payload.screen}
      </div>
    </UNSAFE_LocationContext.Provider>
  )

const layerName = (role: LayerRole, transition: LayerTransition | null): string => {
  if (role === 'top') {
    return transition ? (transition.direction === 'forward' ? 'incoming' : 'outgoing') : 'current'
  }
  if (role === 'bottom') {
    return transition ? (transition.direction === 'forward' ? 'outgoing' : 'incoming') : 'underlay'
  }
  return 'retained'
}

export const PhoneNavigationLayer = ({
  entry,
  gestureProgress,
  hasUnderlay,
  role,
  transition,
}: PhoneNavigationLayerProps) => {
  const hidden = role === 'hidden'
  const inertLayer = role === 'bottom' || Boolean(transition && role === 'top')
  const classes = ['phone-navigation-screen']
  let style: CSSProperties | undefined
  // The finger drives the revealed layer's scrim inline, like its
  // transform; a scripted transition animates it from the same poses.
  let dimStyle: CSSProperties | undefined

  if (role === 'top') {
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
      if (gestureProgress !== null && hasUnderlay) {
        style = {
          boxShadow: 'var(--nav-shadow)',
          transform: `translate3d(${percent(gestureProgress)}, 0, 0)`,
        }
      }
    }
  } else if (role === 'bottom') {
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
      if (gestureProgress !== null) {
        style = { transform: `translate3d(${percent(-(1 - gestureProgress) * NAV_MOTION.parallax)}, 0, 0)` }
        dimStyle = { opacity: dimAt(gestureProgress) }
      }
    }
  }

  return (
    <div
      aria-hidden={inertLayer || hidden ? true : undefined}
      className={classes.join(' ')}
      data-phone-navigation-layer={layerName(role, transition)}
      data-phone-navigation-route={entry.key}
      hidden={hidden || undefined}
      inert={inertLayer || undefined}
      style={style}
    >
      <NavigationScreen payload={entry.payload} />
      <div
        aria-hidden
        className="phone-navigation-dim"
        data-phone-navigation-dim
        style={dimStyle}
      />
    </div>
  )
}
