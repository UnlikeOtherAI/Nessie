import { ActionSheetIOS, Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { withOpacity } from '../lib/ipad-native-chrome'
import {
  nativeScreenBarDisabledIndices,
  nativeScreenBarSheetLabels,
  partitionNativeScreenBarActions,
} from '../lib/native-screen-bar'
import {
  getNativePhoneHeaderHeight,
  type NativeScreenBar,
  type NativeScreenBarAction,
} from '../lib/native-shell-layout'

export type NativePhoneNavBarProps = {
  accentColor: string
  headerSurface: string
  headerText: string
  landscape: boolean
  onAction: (id: string, itemId?: string) => void
  onBack: () => void
  safeTop: number
  screenBar: NativeScreenBar | null
}

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
export const NativePhoneNavBar = ({
  accentColor,
  headerSurface,
  headerText,
  landscape,
  onAction,
  onBack,
  safeTop,
  screenBar,
}: NativePhoneNavBarProps): React.JSX.Element => {
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
      <View style={[styles.content, { paddingTop: safeTop }]}>
        <View style={styles.leading}>
          {back ? (
            <Pressable
              accessibilityLabel={back.label}
              accessibilityRole="button"
              hitSlop={8}
              onPress={onBack}
              style={({ pressed }) => [styles.backButton, pressed ? { opacity: 0.55 } : null]}
            >
              <MaterialIcons color={headerText} name="arrow-back-ios-new" size={20} />
              {/*
                The published label is written for assistive technology — the
                resolver's answers read "Back to channel info", "Back from
                Design review" — so it is the accessibility label, not the
                visible text. A UIKit bar shows the previous screen's name
                there; until the transition descriptors can supply it, plain
                "Back" is honest and never reads as a sentence.
              */}
              <Text
                numberOfLines={1}
                style={[styles.backLabel, { color: headerText }]}
              >
                Back
              </Text>
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
              hitSlop={8}
              onPress={openOverflow}
              style={({ pressed }) => [styles.overflowButton, pressed ? { opacity: 0.55 } : null]}
            >
              <MaterialIcons color={headerText} name="more-horiz" size={22} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
    marginLeft: -4,
    minWidth: 0,
  },
  backLabel: { flexShrink: 1, fontSize: 17, fontWeight: '500' },
  bar: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 30 },
  content: {
    alignItems: 'center',
    flexDirection: 'row',
    height: '100%',
    paddingHorizontal: 12,
  },
  // The two side lanes share a width so the title sits on the bar's centre
  // line rather than the centre of whatever is left over.
  leading: { alignItems: 'flex-start', flexBasis: 0, flexGrow: 1, minWidth: 0 },
  overflowButton: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
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
