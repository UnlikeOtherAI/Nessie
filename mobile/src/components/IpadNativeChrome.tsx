import { useCallback, useState } from 'react'
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native'

import { IpadNativeAccountButton, type IpadNativeAccount } from './IpadNativeAccountMenu'
import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { IpadNativeOverflowMenu } from './IpadNativeOverflowMenu'
import { IpadNativeToolbar, type ToolbarAction, type ToolbarState } from './IpadNativeToolbar'
import { IpadNativeTabBar } from './IpadNativeTabBar'
import { IpadNativeWorkspaceSwitcher } from './IpadNativeWorkspaceSwitcher'
import {
  getIpadTopChromeLayout,
  IPAD_NATIVE_CHROME_GAP,
  IPAD_NATIVE_COMPACT_TOP_CHROME_WIDTH_ESTIMATE,
  IPAD_NATIVE_FULL_TOP_CHROME_WIDTH_ESTIMATE,
  type IpadTopChromeMode,
  type IpadNativeChromeTheme,
} from '../lib/ipad-native-chrome'
import { TABS } from '../lib/tabs'

type IpadNativeChromeProps = {
  activeIndex: number
  account: IpadNativeAccount
  badgeCounts: { assignedWork: number; channels: number; knowledge: number }
  insetLeft: number
  insetRight: number
  onIndexChange: (index: number) => void
  onToggleAccountMenu: () => void
  onToolbarAction: (action: ToolbarAction) => void
  onToggleWorkspaceMenu: (left: number) => void
  theme: IpadNativeChromeTheme
  toolbarState: ToolbarState
  top: number
  windowWidth: number
  workspaceName: string | null
}

export const IpadNativeChrome = ({
  activeIndex,
  account,
  badgeCounts,
  insetLeft,
  insetRight,
  onIndexChange,
  onToggleAccountMenu,
  onToggleWorkspaceMenu,
  onToolbarAction,
  theme,
  toolbarState,
  top,
  windowWidth,
  workspaceName,
}: IpadNativeChromeProps): React.JSX.Element => {
  const [chromeWidth, setChromeWidth] = useState(windowWidth)
  const [controlsWidth, setControlsWidth] = useState<Record<IpadTopChromeMode, number>>({
    compact: IPAD_NATIVE_COMPACT_TOP_CHROME_WIDTH_ESTIMATE,
    full: IPAD_NATIVE_FULL_TOP_CHROME_WIDTH_ESTIMATE,
  })
  const layout = getIpadTopChromeLayout({
    compactControlsWidth: controlsWidth.compact,
    fullControlsWidth: controlsWidth.full,
    hasWorkspace: Boolean(workspaceName),
    insetLeft,
    insetRight,
    screenWidth: chromeWidth,
  })
  const workspaceLeft = insetLeft + IPAD_NATIVE_CHROME_GAP
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
          <IpadNativeChromeSurface style={styles.accountSurface} theme={theme}>
            <IpadNativeAccountButton {...account} onPress={onToggleAccountMenu} theme={theme} />
          </IpadNativeChromeSurface>
        </View>
      </View>
      {workspaceName && layout.workspaceWidth !== null ? (
        <IpadNativeWorkspaceSwitcher
          left={workspaceLeft}
          maxWidth={layout.workspaceWidth}
          name={workspaceName}
          onPress={() => onToggleWorkspaceMenu(workspaceLeft)}
          theme={theme}
          top={top}
        />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  accountSurface: { justifyContent: 'center', width: 42 },
  controls: {
    flexDirection: 'row',
    gap: IPAD_NATIVE_CHROME_GAP,
    position: 'absolute',
  },
  layer: { height: 42, left: 0, position: 'absolute', right: 0, zIndex: 20 },
})
