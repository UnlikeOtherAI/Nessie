import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { androidDockGeometry } from '../lib/android-tablet-dock'
import type { NativeAttentionBadges } from '../lib/native-shell-layout'
import { TABS } from '../lib/tabs'

type AndroidTabletTabBarProps = {
  activeIndex: number
  badgeCounts: NativeAttentionBadges
  activeIndicatorColor: string
  activeTintColor: string
  bottom: number
  dark: boolean
  inactiveTintColor: string
  // Sideways, the pill is shorter and lays each label beside its icon rather
  // than under it. Its height comes from `androidDockGeometry`, the same
  // answer the page's bottom clearance is spent from, so the two cannot drift.
  landscape: boolean
  onIndexChange: (index: number) => void
  rippleColor: string
}

export const AndroidTabletTabBar = ({
  activeIndex,
  badgeCounts,
  activeIndicatorColor,
  activeTintColor,
  bottom,
  dark,
  inactiveTintColor,
  landscape,
  onIndexChange,
  rippleColor,
}: AndroidTabletTabBarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { bottom }]}>
    <View
      style={[
        styles.bar,
        dark ? styles.barDark : styles.barLight,
        landscape ? styles.barLandscape : null,
        { height: androidDockGeometry(landscape).height },
      ]}
    >
      {TABS.map((tab, index) => {
        const active = index === activeIndex
        const color = active ? activeTintColor : inactiveTintColor
        const badge = badgeCounts[tab.key] ?? 0

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
              landscape ? styles.tabLandscape : null,
              active ? { backgroundColor: activeIndicatorColor } : null,
              pressed ? styles.tabPressed : null,
            ]}
            testID={`android-tab-${tab.key}`}
          >
            <MaterialIcons
              color={color}
              name={tab.materialIcon}
              size={landscape ? 20 : 24}
            />
            <Text
              numberOfLines={1}
              style={[styles.label, landscape ? styles.labelLandscape : null, { color }]}
            >
              {tab.title}
            </Text>
            {badge > 0 ? <Text style={styles.badge}>{badge > 99 ? '99+' : badge}</Text> : null}
          </Pressable>
        )
      })}
    </View>
  </View>
)

const styles = StyleSheet.create({
  badge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    overflow: 'hidden',
    color: '#fff',
    backgroundColor: '#7c3aed',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 16,
    textAlign: 'center',
  },
  bar: {
    width: '88%',
    maxWidth: 700,
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
  barLandscape: {
    padding: 4,
    borderRadius: 25,
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
  labelLandscape: {
    marginTop: 0,
    marginLeft: 6,
  },
  layer: {
    position: 'absolute',
    right: 0,
    left: 0,
    zIndex: 20,
    alignItems: 'center',
  },
  tab: {
    height: 58,
    minWidth: 48,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
  },
  // Icon and label side by side: the row is what buys back the height, and it
  // keeps every tab's target the full width of its lane.
  tabLandscape: {
    height: 42,
    flexDirection: 'row',
    borderRadius: 21,
  },
  tabPressed: {
    opacity: 0.74,
  },
})
