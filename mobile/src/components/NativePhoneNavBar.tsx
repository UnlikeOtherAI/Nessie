import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import {
  getNativePhoneHeaderHeight,
  type NativeScreenBar,
} from '../lib/native-shell-layout'

export type NativePhoneNavBarProps = {
  headerSurface: string
  headerText: string
  landscape: boolean
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
  headerSurface,
  headerText,
  landscape,
  onBack,
  safeTop,
  screenBar,
}: NativePhoneNavBarProps): React.JSX.Element => {
  const back = screenBar?.back ?? null
  const title = screenBar?.title ?? ''

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
              <Text
                numberOfLines={1}
                style={[styles.backLabel, { color: headerText }]}
              >
                {back.label}
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

        {/*
          Reserved for the screen's own actions. Kept as a sized lane from the
          start so the centred title is measured against the same geometry once
          they arrive, rather than shifting when the first action appears.
        */}
        <View style={styles.trailing} pointerEvents="box-none" />
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
  title: { fontSize: 17, fontWeight: '700' },
  titleLane: { alignItems: 'center', flexShrink: 1, minWidth: 0, paddingHorizontal: 8 },
  trailing: { alignItems: 'flex-end', flexBasis: 0, flexGrow: 1, minWidth: 0 },
})
