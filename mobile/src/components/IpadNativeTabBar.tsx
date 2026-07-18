import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { TABS } from '../lib/tabs'

type IpadNativeTabBarProps = {
  activeIndex: number
  activeTintColor: string
  dark: boolean
  inactiveTintColor: string
  onIndexChange: (index: number) => void
  top: number
}

export const IpadNativeTabBar = ({
  activeIndex,
  activeTintColor,
  dark,
  inactiveTintColor,
  onIndexChange,
  top,
}: IpadNativeTabBarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { top }]}>
    <View style={[styles.bar, dark ? styles.barDark : styles.barLight]}>
      {TABS.map((tab, index) => {
        const active = index === activeIndex
        const color = active ? activeTintColor : inactiveTintColor

        return (
          <Pressable
            accessible
            accessibilityLabel={tab.title}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            hitSlop={4}
            key={tab.key}
            onAccessibilityTap={() => onIndexChange(index)}
            onPress={() => onIndexChange(index)}
            testID={`ipad-tab-${tab.key}`}
            style={({ pressed }) => [
              styles.tab,
              tab.key === 'search' ? styles.searchTab : null,
              active ? (dark ? styles.tabActiveDark : styles.tabActiveLight) : null,
              pressed ? styles.tabPressed : null,
            ]}
          >
            {tab.key === 'search' ? (
              <MaterialIcons color={color} name={tab.materialIcon} size={22} />
            ) : (
              <Text numberOfLines={1} style={[styles.label, { color }]}>
                {tab.title}
              </Text>
            )}
          </Pressable>
        )
      })}
    </View>
  </View>
)

const styles = StyleSheet.create({
  bar: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
  },
  barDark: {
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  barLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
    borderColor: 'rgba(15, 23, 42, 0.1)',
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
  tabActiveDark: {
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  tabActiveLight: {
    backgroundColor: 'rgba(15, 23, 42, 0.08)',
  },
  tabPressed: {
    opacity: 0.68,
  },
})
