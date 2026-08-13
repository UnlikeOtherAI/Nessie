import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import {
  IPAD_NATIVE_CHROME_GAP,
  IPAD_NATIVE_CHROME_HEIGHT,
  type IpadNativeChromeTheme,
} from '../lib/ipad-native-chrome'
import { TABS, type TabDef } from '../lib/tabs'

const PRIMARY_TABS = TABS.filter((tab) => tab.key !== 'search')
const SEARCH_TAB = TABS.find((tab) => tab.key === 'search')

type IpadNativeTabBarProps = {
  activeIndex: number
  badgeCounts: { assignedWork: number; channels: number; knowledge: number }
  iconOnly: boolean
  onIndexChange: (index: number) => void
  showSearch: boolean
  theme: IpadNativeChromeTheme
}

type IpadNativeTabButtonProps = {
  activeIndex: number
  badgeCounts: IpadNativeTabBarProps['badgeCounts']
  iconOnly: boolean
  onIndexChange: IpadNativeTabBarProps['onIndexChange']
  tab: TabDef
  theme: IpadNativeChromeTheme
}

const IpadNativeTabButton = ({
  activeIndex,
  badgeCounts,
  iconOnly,
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
        iconOnly ? styles.iconTab : null,
        active ? { backgroundColor: theme.activeBackgroundColor } : null,
        pressed ? { backgroundColor: theme.pressedBackgroundColor } : null,
      ]}
    >
      {tab.key === 'search' || iconOnly ? (
        <MaterialIcons color={color} name={tab.materialIcon} size={22} />
      ) : (
        <Text numberOfLines={1} style={[styles.label, { color }]}>
          {tab.title}
        </Text>
      )}
      {badge > 0 ? (
        <Text style={[styles.badge, iconOnly ? styles.iconBadge : null, { backgroundColor: theme.activeTintColor }]}>
          {badge > 99 ? '99+' : badge}
        </Text>
      ) : null}
    </Pressable>
  )
}

export const IpadNativeTabBar = ({
  activeIndex,
  badgeCounts,
  iconOnly,
  onIndexChange,
  showSearch,
  theme,
}: IpadNativeTabBarProps): React.JSX.Element => (
  <View style={styles.controls}>
    <IpadNativeChromeSurface theme={theme}>
      {PRIMARY_TABS.map((tab) => (
        <IpadNativeTabButton
          activeIndex={activeIndex}
          badgeCounts={badgeCounts}
          iconOnly={iconOnly}
          key={tab.key}
          onIndexChange={onIndexChange}
          tab={tab}
          theme={theme}
        />
      ))}
    </IpadNativeChromeSurface>
    {showSearch && SEARCH_TAB ? (
      <IpadNativeChromeSurface style={styles.searchSurface} theme={theme}>
        <IpadNativeTabButton
          activeIndex={activeIndex}
          badgeCounts={badgeCounts}
          iconOnly={false}
          onIndexChange={onIndexChange}
          tab={SEARCH_TAB}
          theme={theme}
        />
      </IpadNativeChromeSurface>
    ) : null}
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
  iconBadge: {
    position: 'absolute',
    right: -4,
    top: -4,
  },
  iconTab: {
    minWidth: 34,
    paddingHorizontal: 0,
    width: 34,
  },
  searchTab: {
    width: IPAD_NATIVE_CHROME_HEIGHT - 8,
    minWidth: 0,
    paddingHorizontal: 0,
  },
  // Search is intentionally square. Its fixed frame lets the inner 34-point
  // target and magnifier share the exact same centre on every iPad size.
  searchSurface: {
    width: IPAD_NATIVE_CHROME_HEIGHT,
    justifyContent: 'center',
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
