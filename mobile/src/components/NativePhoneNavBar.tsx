import { useEffect, useRef } from 'react'
import {
  AccessibilityInfo,
  ActionSheetIOS,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import Svg, { Path } from 'react-native-svg'

import { withOpacity } from '../lib/ipad-native-chrome'
import {
  nativeScreenBarDisabledIndices,
  nativeScreenBarSheetLabels,
  partitionNativeScreenBarActions,
} from '../lib/native-screen-bar'
import {
  currentNativeScreenBar,
  nativeScreenBarTransitionLanes,
  type NativeScreenBarState,
} from '../lib/native-screen-bar-state'
import {
  getNativePhoneHeaderHeight,
  type NativeScreenBar,
  type NativeScreenBarAction,
} from '../lib/native-shell-layout'

export type NativePhoneNavBarProps = {
  accentColor: string
  barState: NativeScreenBarState
  dark: boolean
  headerSurface: string
  headerText: string
  landscape: boolean
  onAction: (id: string, itemId?: string) => void
  onBack: () => void
  onTransitionEnd: () => void
  safeTop: number
}

/**
 * The Back chevron, drawn rather than taken from an icon font.
 *
 * An icon font's glyph carries its own bearing, so centring it in the circle
 * means compensating for a number nobody wrote down — and the compensation is
 * wrong the moment the glyph or its size changes. This is the same path the
 * web's `PhoneBackButton` draws, shifted so it is symmetric about the
 * viewBox's centre line: x runs 8.5 to 15.5 about 12, y runs 5 to 19 about 12.
 * Centred by construction, at any size.
 */
const BackChevron = ({ color, size }: { color: string, size: number }): React.JSX.Element => (
  <Svg height={size} viewBox="0 0 24 24" width={size}>
    <Path
      d="m15.5 19-7-7 7-7"
      fill="none"
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.1}
    />
  </Svg>
)

// The stack's own curve and duration (admin/src/navigation/motion.ts). The bar
// travels on the layers' curve or it is visibly a separate thing bolted above
// them; the duration comes over the wire, because a released swipe settles
// over whatever travel remains rather than a fixed 300ms.
const NAV_EASING = Easing.bezier(0.22, 1, 0.36, 1)
// How far a title slides while it crossfades. UIKit moves it a short distance
// in the direction of travel; a full-width slide would read as a second
// content layer rather than chrome.
const TITLE_TRAVEL = 24

/**
 * The navigation bar on a screen that is not a tab root.
 *
 * Deliberately the same height as the root header
 * (`getNativePhoneHeaderHeight`), because the band's height is what
 * `getNativeWebviewFrameInsets` reserves: a bar that grew or shrank with the
 * screen would put the WebView's own frame back under the control of
 * navigation, which is the defect this replaced
 * (docs/plans/2026-09-05-ios-native-navigation-bar.md §4).
 *
 * It draws what the admin published for the layer the reader is standing on,
 * and nothing it derives for itself. In particular it never falls back to the
 * root's team and account controls: before the first descriptor of a cold
 * start, and for the frame between a forward push starting and the incoming
 * screen publishing, the bar is bare surface. A team switcher briefly flashing
 * above a conversation is worse than an empty band.
 */
const NavBarLanes = ({
  accentColor,
  dark,
  headerText,
  onAction,
  onBack,
  safeTop,
  screenBar,
}: {
  accentColor: string
  dark: boolean
  headerText: string
  onAction: (id: string, itemId?: string) => void
  onBack: () => void
  safeTop: number
  screenBar: NativeScreenBar | null
}): React.JSX.Element => {
  const back = screenBar?.back ?? null
  const title = screenBar?.title ?? ''
  const { overflow, primary } = partitionNativeScreenBarActions(screenBar?.actions ?? [])

  // A menu opens a second sheet rather than being flattened into the first, so
  // a reader never has to work out which group a row belonged to.
  const openMenu = (action: NativeScreenBarAction): void => {
    const items = action.items ?? []
    ActionSheetIOS.showActionSheetWithOptions({
      cancelButtonIndex: items.length,
      disabledButtonIndices: items
        .map((item, index) => (item.disabled ? index : -1))
        .filter((index) => index !== -1),
      options: [
        ...items.map((item) => (item.checked ? `✓ ${item.label}` : item.label)),
        'Cancel',
      ],
      title: action.label,
    }, (index) => {
      const item = items[index]
      if (item) onAction(action.id, item.id)
    })
  }

  const openOverflow = (): void => {
    ActionSheetIOS.showActionSheetWithOptions({
      cancelButtonIndex: overflow.length,
      destructiveButtonIndex: overflow.findIndex((action) => action.tone === 'danger'),
      disabledButtonIndices: nativeScreenBarDisabledIndices(overflow),
      options: nativeScreenBarSheetLabels(overflow),
      title: title || undefined,
    }, (index) => {
      const action = overflow[index]
      if (!action) return
      if (action.kind === 'menu') {
        openMenu(action)
        return
      }
      onAction(action.id)
    })
  }

  return (
    // The status-bar inset belongs on the row itself, not on a wrapper above
    // it: each lane is absolutely positioned, and an absolutely positioned
    // child is laid out against its parent's border box, so padding on the
    // wrapper is ignored and the row would centre over the whole band —
    // including the status bar — leaving a dead gap beneath it.
    <View style={[styles.content, { paddingTop: safeTop }]}>
        <View style={styles.leading}>
          {back ? (
            /*
              A circle holding the chevron alone, which is what the current
              iOS bar is — not the older chevron-plus-label. The web's own
              `PhoneBackButton` already draws this treatment for the iOS phone
              shell; this is the native side agreeing with it.

              The published label reads "Back to channel info", "Back from
              Design review" — written for assistive technology, and a
              sentence rather than a caption — so it stays the accessibility
              label and nothing draws it.

              Lighter than the surface in both themes, per the platform: a
              translucent white over dark, and near-solid white over light.
            */
            <Pressable
              accessibilityLabel={back.label}
              accessibilityRole="button"
              hitSlop={10}
              onPress={onBack}
              style={({ pressed }) => [
                styles.backButton,
                {
                  backgroundColor: dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.9)',
                  borderColor: dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.06)',
                },
                pressed ? { opacity: 0.55 } : null,
              ]}
            >
              <BackChevron color={headerText} size={20} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.titleLane} pointerEvents="none">
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={[styles.title, { color: headerText }]}
          >
            {title}
          </Text>
        </View>

        <View style={styles.trailing} pointerEvents="box-none">
          {primary ? (
            <Pressable
              accessibilityLabel={primary.label}
              accessibilityRole="button"
              accessibilityState={{ selected: primary.selected }}
              hitSlop={8}
              onPress={() => (primary.kind === 'menu' ? openMenu(primary) : onAction(primary.id))}
              style={({ pressed }) => [
                styles.primaryAction,
                // `selected` is state, not decoration: a live call, an open
                // search and a recording routine all say so through it, and a
                // bar that drew them the same as an idle button would be
                // lying about what the screen is doing.
                primary.selected ? { backgroundColor: withOpacity(accentColor, 0.16) } : null,
                pressed ? { opacity: 0.55 } : null,
              ]}
            >
              <Text numberOfLines={1} style={[styles.primaryLabel, { color: accentColor }]}>
                {primary.label}
              </Text>
            </Pressable>
          ) : null}
          {overflow.length > 0 ? (
            <Pressable
              accessibilityLabel="More actions"
              accessibilityRole="button"
              hitSlop={10}
              onPress={openOverflow}
              style={({ pressed }) => [
                // The same glass circle as the Back: a bare glyph beside one
                // would read as a half-migrated bar.
                styles.circleButton,
                {
                  backgroundColor: dark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.9)',
                  borderColor: dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.06)',
                },
                pressed ? { opacity: 0.55 } : null,
              ]}
            >
              <MaterialIcons color={headerText} name="more-horiz" size={20} />
            </Pressable>
          ) : null}
        </View>
    </View>
  )
}

/**
 * The bar, and the stack transition it runs alongside.
 *
 * Two lanes, crossfaded: the layer being left and the layer being travelled
 * to. It cannot be one lane updated at the end, because the layers move for
 * 300ms and a bar that changed only when they landed would read as a separate
 * thing above them — and it cannot be one lane updated at the start, because
 * on a forward push the incoming descriptor has not arrived yet and the bar
 * would blank for a frame before filling.
 */
export const NativePhoneNavBar = ({
  accentColor,
  barState,
  dark,
  headerSurface,
  headerText,
  landscape,
  onAction,
  onBack,
  onTransitionEnd,
  safeTop,
}: NativePhoneNavBarProps): React.JSX.Element => {
  const lanes = nativeScreenBarTransitionLanes(barState)
  const resting = currentNativeScreenBar(barState)
  const transition = barState.transition
  const progress = useRef(new Animated.Value(1)).current
  const reduceMotion = useRef(false)

  useEffect(() => {
    let cancelled = false
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (!cancelled) reduceMotion.current = enabled })
      .catch(() => undefined)
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => { reduceMotion.current = enabled },
    )
    return () => { cancelled = true; subscription.remove() }
  }, [])

  // Keyed on the transition itself, so a descriptor arriving late for the
  // incoming lane fills it without restarting the motion.
  const transitionKey = transition ? `${transition.from}->${transition.to}` : null
  useEffect(() => {
    if (!transition) return undefined
    progress.setValue(0)
    const animation = Animated.timing(progress, {
      duration: reduceMotion.current ? 0 : transition.durationMs,
      easing: NAV_EASING,
      toValue: 1,
      useNativeDriver: true,
    })
    animation.start(({ finished }) => { if (finished) onTransitionEnd() })
    return () => animation.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, transitionKey])

  const forward = transition?.direction === 'forward'
  const outgoingStyle = {
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [{
      translateX: progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, forward ? -TITLE_TRAVEL : TITLE_TRAVEL],
      }),
    }],
  }
  const incomingStyle = {
    opacity: progress,
    transform: [{
      translateX: progress.interpolate({
        inputRange: [0, 1],
        outputRange: [forward ? TITLE_TRAVEL : -TITLE_TRAVEL, 0],
      }),
    }],
  }

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.bar,
        {
          backgroundColor: headerSurface,
          height: safeTop + getNativePhoneHeaderHeight(landscape),
        },
      ]}
    >
      <View style={styles.lanes} pointerEvents="box-none">
        {lanes ? (
          <>
            <Animated.View pointerEvents="none" style={[styles.lane, outgoingStyle]}>
              <NavBarLanes
                accentColor={accentColor}
                dark={dark}
                headerText={headerText}
                onAction={onAction}
                onBack={onBack}
                safeTop={safeTop}
                screenBar={lanes.outgoing}
              />
            </Animated.View>
            <Animated.View style={[styles.lane, incomingStyle]}>
              <NavBarLanes
                accentColor={accentColor}
                dark={dark}
                headerText={headerText}
                onAction={onAction}
                onBack={onBack}
                safeTop={safeTop}
                screenBar={lanes.incoming}
              />
            </Animated.View>
          </>
        ) : (
          <View style={styles.lane}>
            <NavBarLanes
              accentColor={accentColor}
              dark={dark}
              headerText={headerText}
              onAction={onAction}
              onBack={onBack}
              safeTop={safeTop}
              screenBar={resting}
            />
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backButton: {
    alignItems: 'center',
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  circleButton: {
    alignItems: 'center',
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  bar: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 30 },
  content: {
    alignItems: 'center',
    flexDirection: 'row',
    height: '100%',
    paddingHorizontal: 12,
  },
  lane: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  lanes: { flex: 1 },
  // The two side lanes share a width so the title sits on the bar's centre
  // line rather than the centre of whatever is left over.
  leading: { alignItems: 'flex-start', flexBasis: 0, flexGrow: 1, minWidth: 0 },
  primaryAction: { borderRadius: 14, flexShrink: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 4 },
  primaryLabel: { fontSize: 17, fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700' },
  titleLane: { alignItems: 'center', flexShrink: 1, minWidth: 0, paddingHorizontal: 8 },
  trailing: {
    alignItems: 'center',
    flexBasis: 0,
    flexDirection: 'row',
    flexGrow: 1,
    gap: 4,
    justifyContent: 'flex-end',
    minWidth: 0,
  },
})
