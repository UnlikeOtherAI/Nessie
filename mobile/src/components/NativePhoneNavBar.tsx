import { StyleSheet, View } from 'react-native'

import { getNativePhoneHeaderHeight } from '../lib/native-shell-layout'

export type NativePhoneNavBarProps = {
  headerSurface: string
  landscape: boolean
  safeTop: number
}

/**
 * The navigation band on a screen that is not a tab root.
 *
 * It is deliberately the same height as the root header
 * (`getNativePhoneHeaderHeight`), because the band's height is what
 * `getNativeWebviewFrameInsets` reserves: a band that varied by screen would
 * put the WebView's own frame back under the control of navigation, which is
 * the defect this replaced (docs/plans/2026-09-05-ios-native-navigation-bar.md
 * §4).
 *
 * It carries nothing yet. The back button, the title and the screen's actions
 * arrive with the next slice; showing the team switcher and account avatar
 * here in the meantime would put a root's controls above a conversation, so
 * the band stays bare. It paints `headerSurface` rather than the page
 * background so the status bar keeps the one backdrop it derives its style
 * from, and the geometry fix does not trade a jump for a colour snap.
 */
export const NativePhoneNavBar = ({
  headerSurface,
  landscape,
  safeTop,
}: NativePhoneNavBarProps): React.JSX.Element => (
  <View
    pointerEvents="none"
    style={[
      styles.bar,
      {
        backgroundColor: headerSurface,
        height: safeTop + getNativePhoneHeaderHeight(landscape),
      },
    ]}
  />
)

const styles = StyleSheet.create({
  bar: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 30 },
})
