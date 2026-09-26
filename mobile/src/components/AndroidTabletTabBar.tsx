import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { BlurView } from 'expo-blur'
import type { RefObject } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'

import { androidDockGeometry } from '../lib/android-tablet-dock'
import { withOpacity } from '../lib/ipad-native-chrome'
import type { NativeAttentionBadges } from '../lib/native-shell-layout'
import { TABS } from '../lib/tabs'

type AndroidTabletTabBarProps = {
  activeIndex: number
  badgeCounts: NativeAttentionBadges
  blurTarget: RefObject<View | null>
  activeIndicatorColor: string
  activeTintColor: string
  bottom: number
  dark: boolean
  inactiveTintColor: string
  // Sideways, the pill is shorter and lays each label beside its icon rather
  // than under it. Its height comes from `androidDockGeometry`, the same
  // answer the page's bottom clearance is spent from, so the two cannot drift.
  landscape: boolean
  onAccentColor: string
  onIndexChange: (index: number) => void
  rippleColor: string
  surfaceColor: string
}

export const AndroidTabletTabBar = ({
  activeIndex,
  badgeCounts,
  blurTarget,
  activeIndicatorColor,
  activeTintColor,
  bottom,
  dark,
  inactiveTintColor,
  landscape,
  onAccentColor,
  onIndexChange,
  rippleColor,
  surfaceColor,
}: AndroidTabletTabBarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { bottom }]}>
    <View
      style={[
        styles.bar,
        landscape ? styles.barLandscape : null,
        {
          backgroundColor: withOpacity(surfaceColor, 0.18),
          height: androidDockGeometry(landscape).height,
        },
      ]}
    >
      <View style={[
        styles.glass,
        landscape ? styles.glassLandscape : null,
        {
          borderColor: withOpacity(inactiveTintColor, dark ? 0.32 : 0.24),
          borderTopColor: withOpacity('#ffffff', dark ? 0.38 : 0.86),
        },
      ]}>
        <BlurView
          blurMethod="dimezisBlurViewSdk31Plus"
          blurTarget={blurTarget}
          intensity={70}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          tint={dark ? 'dark' : 'light'}
        />
        {/* Older Android versions keep an opaque-enough tint for legibility;
            current devices sample the live WebView through the blur target. */}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: withOpacity(surfaceColor, Number(Platform.Version) < 31 ? 0.92 : 0.5) },
          ]}
        />
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
                active ? {
                  backgroundColor: activeIndicatorColor,
                  borderColor: withOpacity(activeTintColor, 0.24),
                } : null,
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
              {badge > 0 ? (
                <Text style={[styles.badge, { backgroundColor: activeTintColor, color: onAccentColor }]}>
                  {badge > 99 ? '99+' : badge}
                </Text>
              ) : null}
            </Pressable>
          )
        })}
      </View>
    </View>
  </View>
)

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: 2,
    right: 4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    overflow: 'hidden',
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 16,
    textAlign: 'center',
  },
  bar: {
    width: '88%',
    maxWidth: 700,
    borderRadius: 35,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 18,
  },
  barLandscape: { borderRadius: 25 },
  glass: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
    borderWidth: 1,
    borderRadius: 35,
    overflow: 'hidden',
  },
  glassLandscape: {
    padding: 4,
    borderRadius: 25,
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
    alignSelf: 'stretch',
    minWidth: 48,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // Icon and label side by side: the row is what buys back the height, and it
  // keeps every tab's target the full width of its lane.
  tabLandscape: {
    flexDirection: 'row',
    borderRadius: 21,
  },
  tabPressed: {
    opacity: 0.74,
  },
})
