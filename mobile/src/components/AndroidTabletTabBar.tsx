import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { TABS } from '../lib/tabs'

const BAR_HEIGHT = 70
export const ANDROID_TABLET_TAB_BAR_BOTTOM_GAP = 8
const CONTENT_GAP = 16

export const ANDROID_TABLET_TAB_BAR_CONTENT_INSET = BAR_HEIGHT + ANDROID_TABLET_TAB_BAR_BOTTOM_GAP + CONTENT_GAP

type AndroidTabletTabBarProps = {
  activeIndex: number
  activeIndicatorColor: string
  activeTintColor: string
  bottom: number
  dark: boolean
  inactiveTintColor: string
  onIndexChange: (index: number) => void
  rippleColor: string
  separatorColor: string
}

export const AndroidTabletTabBar = ({
  activeIndex,
  activeIndicatorColor,
  activeTintColor,
  bottom,
  dark,
  inactiveTintColor,
  onIndexChange,
  rippleColor,
  separatorColor,
}: AndroidTabletTabBarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { bottom }]}>
    <View
      pointerEvents="none"
      style={[styles.separator, { backgroundColor: separatorColor, bottom: BAR_HEIGHT + CONTENT_GAP }]}
    />
    <View style={[styles.bar, dark ? styles.barDark : styles.barLight]}>
      {TABS.map((tab, index) => {
        const active = index === activeIndex
        const color = active ? activeTintColor : inactiveTintColor

        return (
          <Pressable
            accessible
            accessibilityLabel={tab.title}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            android_ripple={{ borderless: false, color: rippleColor }}
            hitSlop={2}
            key={tab.key}
            onAccessibilityTap={() => onIndexChange(index)}
            onPress={() => onIndexChange(index)}
            style={({ pressed }) => [
              styles.tab,
              active ? { backgroundColor: activeIndicatorColor } : null,
              pressed ? styles.tabPressed : null,
            ]}
            testID={`android-tab-${tab.key}`}
          >
            <MaterialIcons
              color={color}
              name={active ? tab.activeMaterialIcon : tab.materialIcon}
              size={24}
            />
            <Text numberOfLines={1} style={[styles.label, { color }]}>
              {tab.title}
            </Text>
          </Pressable>
        )
      })}
    </View>
  </View>
)

const styles = StyleSheet.create({
  bar: {
    width: '88%',
    maxWidth: 700,
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 30,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
  },
  barDark: {
    backgroundColor: '#211b17',
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  barLight: {
    backgroundColor: '#fffaf2',
    borderColor: 'rgba(72, 48, 24, 0.12)',
  },
  label: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 14,
  },
  layer: {
    position: 'absolute',
    right: 0,
    left: 0,
    zIndex: 20,
    alignItems: 'center',
  },
  separator: {
    position: 'absolute',
    right: 0,
    left: 0,
    height: StyleSheet.hairlineWidth,
  },
  tab: {
    height: 58,
    minWidth: 48,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
  },
  tabPressed: {
    opacity: 0.74,
  },
})
