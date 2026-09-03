import { useCallback, useState } from 'react'
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native'

import { IpadNativeAccountButton, type IpadNativeAccount } from './IpadNativeAccountMenu'
import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { NativeFocusModeButton } from './NativeFocusModeButton'
import { IpadNativeOverflowMenu } from './IpadNativeOverflowMenu'
import { IpadNativeToolbar, type ToolbarAction, type ToolbarState } from './IpadNativeToolbar'
import { IpadNativeTabBar } from './IpadNativeTabBar'
import { IpadNativeTeamSwitcher } from './IpadNativeTeamSwitcher'
import {
  getIpadTopChromeLayout,
  getIpadTeamMenuAnchorLeft,
  IPAD_NATIVE_CHROME_GAP,
  IPAD_NATIVE_COMPACT_TOP_CHROME_WIDTH_ESTIMATE,
  IPAD_NATIVE_FULL_TOP_CHROME_WIDTH_ESTIMATE,
  IPAD_NATIVE_ICON_TOP_CHROME_WIDTH_ESTIMATE,
  IPAD_NATIVE_TRAILING_ACCOUNT_WIDTH,
  type IpadTopChromeMode,
  type IpadNativeChromeTheme,
} from '../lib/ipad-native-chrome'
import type { NativeAttentionBadges } from '../lib/native-shell-layout'
import { TABS } from '../lib/tabs'

type IpadNativeChromeProps = {
  activeIndex: number
  account: IpadNativeAccount
  badgeCounts: NativeAttentionBadges
  insetLeft: number
  insetRight: number
  leadingReservedWidth: number
  onIndexChange: (index: number) => void
  onToggleAccountMenu: () => void
  onToggleFocusMode: () => void
  onToolbarAction: (action: ToolbarAction) => void
  onToggleTeamMenu: (left: number) => void
  theme: IpadNativeChromeTheme
  toolbarState: ToolbarState
  top: number
  windowWidth: number
  teamAvatarUrl: string | null
  teamName: string | null
}

export const IpadNativeChrome = ({
  activeIndex,
  account,
  badgeCounts,
  insetLeft,
  insetRight,
  leadingReservedWidth,
  onIndexChange,
  onToggleAccountMenu,
  onToggleFocusMode,
  onToggleTeamMenu,
  onToolbarAction,
  theme,
  toolbarState,
  top,
  windowWidth,
  teamAvatarUrl,
  teamName,
}: IpadNativeChromeProps): React.JSX.Element => {
  const [chromeWidth, setChromeWidth] = useState(windowWidth)
  const [controlsWidth, setControlsWidth] = useState<Record<IpadTopChromeMode, number>>({
    compact: IPAD_NATIVE_COMPACT_TOP_CHROME_WIDTH_ESTIMATE,
    full: IPAD_NATIVE_FULL_TOP_CHROME_WIDTH_ESTIMATE,
    icons: IPAD_NATIVE_ICON_TOP_CHROME_WIDTH_ESTIMATE,
  })
  const layout = getIpadTopChromeLayout({
    compactControlsWidth: controlsWidth.compact,
    fullControlsWidth: controlsWidth.full,
    hasTeam: Boolean(teamName),
    iconControlsWidth: controlsWidth.icons,
    insetLeft,
    insetRight,
    leadingReservedWidth,
    screenWidth: chromeWidth,
    trailingReservedWidth: IPAD_NATIVE_TRAILING_ACCOUNT_WIDTH + IPAD_NATIVE_CHROME_GAP,
  })
  const teamLeft = insetLeft + leadingReservedWidth + IPAD_NATIVE_CHROME_GAP
  const searchIndex = TABS.findIndex((tab) => tab.key === 'search')
  const onControlsLayout = useCallback((event: LayoutChangeEvent): void => {
    const width = Math.round(event.nativeEvent.layout.width)
    setControlsWidth((current) => current[layout.mode] === width
      ? current
      : { ...current, [layout.mode]: width })
  }, [layout.mode])
  const onChromeLayout = useCallback((event: LayoutChangeEvent): void => {
    const width = Math.round(event.nativeEvent.layout.width)
    setChromeWidth((current) => current === width ? current : width)
  }, [])

  return (
    <>
      <View
        onLayout={onChromeLayout}
        pointerEvents="box-none"
        style={[styles.layer, { top }]}
      >
        <View
          onLayout={onControlsLayout}
          style={[styles.controls, { left: layout.controlsLeft }]}
        >
          {layout.mode === 'full' ? (
            <IpadNativeToolbar
              canBack={toolbarState.canBack}
              canForward={toolbarState.canForward}
              onAction={onToolbarAction}
              recentOpen={toolbarState.recentOpen}
              theme={theme}
            />
          ) : null}
          <IpadNativeTabBar
            activeIndex={activeIndex}
            badgeCounts={badgeCounts}
            iconOnly={layout.mode === 'icons'}
            onIndexChange={onIndexChange}
            showSearch={layout.mode === 'full'}
            theme={theme}
          />
          {layout.mode === 'compact' ? (
            <IpadNativeOverflowMenu
              onSearchPress={() => searchIndex !== -1 && onIndexChange(searchIndex)}
              onToolbarAction={onToolbarAction}
              theme={theme}
              toolbarState={toolbarState}
            />
          ) : null}
        </View>
        <IpadNativeChromeSurface
          style={[styles.accountSurface, { right: insetRight + IPAD_NATIVE_CHROME_GAP }]}
          theme={theme}
        >
          <NativeFocusModeButton
            activeBackgroundColor={theme.activeBackgroundColor}
            activeTintColor={theme.activeTintColor}
            enabled={account.focusModeEnabled}
            inactiveTintColor={theme.inactiveTintColor}
            onPress={onToggleFocusMode}
          />
          <IpadNativeAccountButton {...account} onPress={onToggleAccountMenu} theme={theme} />
        </IpadNativeChromeSurface>
      </View>
      {teamName && layout.teamWidth !== null ? (
        <IpadNativeTeamSwitcher
          imageUrl={teamAvatarUrl}
          left={teamLeft}
          maxWidth={layout.teamWidth}
          name={teamName}
          onPress={() => onToggleTeamMenu(getIpadTeamMenuAnchorLeft(teamLeft))}
          theme={theme}
          top={top}
        />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  accountSurface: {
    justifyContent: 'center',
    position: 'absolute',
    top: 0,
    width: IPAD_NATIVE_TRAILING_ACCOUNT_WIDTH,
  },
  controls: {
    flexDirection: 'row',
    gap: IPAD_NATIVE_CHROME_GAP,
    position: 'absolute',
  },
  layer: { height: 42, left: 0, position: 'absolute', right: 0, zIndex: 20 },
})
