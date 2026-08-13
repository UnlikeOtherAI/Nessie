import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { IPAD_NATIVE_CHROME_GAP, type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'
import { TABS, type TabDef } from '../lib/tabs'

const PRIMARY_TABS = TABS.filter((tab) => tab.key !== 'search')
const SEARCH_TAB = TABS.find((tab) => tab.key === 'search')

type IpadNativeTabBarProps = {
  activeIndex: number
  badgeCounts: { assignedWork: number; channels: number; knowledge: number }
  onIndexChange: (index: number) => void
  onWidthChange: (width: number) => void
  theme: IpadNativeChromeTheme
  top: number
}

type IpadNativeTabButtonProps = {
  activeIndex: number
  badgeCounts: IpadNativeTabBarProps['badgeCounts']
  onIndexChange: IpadNativeTabBarProps['onIndexChange']
  tab: TabDef
  theme: IpadNativeChromeTheme
}

const IpadNativeTabButton = ({
  activeIndex,
  badgeCounts,
  onIndexChange,
  tab,
  theme,
}: IpadNativeTabButtonProps): React.JSX.Element => {
  const index = TABS.indexOf(tab)
  const active = index === activeIndex
  const color = active ? theme.activeTintColor : theme.inactiveTintColor
  const badge = tab.key === 'channels'
    ? badgeCounts.channels
    : tab.key === 'projects'
      ? badgeCounts.assignedWork
      : tab.key === 'knowledge'
        ? badgeCounts.knowledge
        : 0

  return (
    <Pressable
      accessible
      accessibilityLabel={tab.title}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={tab.key === 'search' ? 5 : 4}
      onAccessibilityTap={() => onIndexChange(index)}
      onPress={() => onIndexChange(index)}
      testID={`ipad-tab-${tab.key}`}
      style={({ pressed }) => [
        styles.tab,
        tab.key === 'search' ? styles.searchTab : null,
        active ? { backgroundColor: theme.activeBackgroundColor } : null,
        pressed ? { backgroundColor: theme.pressedBackgroundColor } : null,
      ]}
    >
      {tab.key === 'search' ? (
        <MaterialIcons color={color} name={tab.materialIcon} size={22} />
      ) : (
        <Text numberOfLines={1} style={[styles.label, { color }]}>
          {tab.title}
        </Text>
      )}
      {badge > 0 ? (
        <Text style={[styles.badge, { backgroundColor: theme.activeTintColor }]}>
          {badge > 99 ? '99+' : badge}
        </Text>
      ) : null}
    </Pressable>
  )
}

export const IpadNativeTabBar = ({
  activeIndex,
  badgeCounts,
  onIndexChange,
  onWidthChange,
  theme,
  top,
}: IpadNativeTabBarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { top }]}>
    <View
      onLayout={(event: LayoutChangeEvent) => onWidthChange(event.nativeEvent.layout.width)}
      style={styles.controls}
    >
      <IpadNativeChromeSurface theme={theme}>
        {PRIMARY_TABS.map((tab) => (
          <IpadNativeTabButton
            activeIndex={activeIndex}
            badgeCounts={badgeCounts}
            key={tab.key}
            onIndexChange={onIndexChange}
            tab={tab}
            theme={theme}
          />
        ))}
      </IpadNativeChromeSurface>
      {SEARCH_TAB ? (
        <IpadNativeChromeSurface theme={theme}>
          <IpadNativeTabButton
            activeIndex={activeIndex}
            badgeCounts={badgeCounts}
            onIndexChange={onIndexChange}
            tab={SEARCH_TAB}
            theme={theme}
          />
        </IpadNativeChromeSurface>
      ) : null}
    </View>
  </View>
)

const styles = StyleSheet.create({
  badge: {
    minWidth: 15,
    height: 15,
    paddingHorizontal: 4,
    borderRadius: 8,
    overflow: 'hidden',
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 15,
    textAlign: 'center',
  },
  controls: {
    flexDirection: 'row',
    gap: IPAD_NATIVE_CHROME_GAP,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
  },
  layer: {
    position: 'absolute',
    right: 0,
    left: 0,
    zIndex: 20,
    alignItems: 'center',
  },
  searchTab: {
    width: 38,
    paddingHorizontal: 0,
  },
  tab: {
    height: 34,
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 17,
  },
})
