import { StyleSheet, View } from 'react-native'
import TabView from 'react-native-bottom-tabs'

import { getIphoneTabBarHostHeight } from '../lib/iphone-tab-bar'
import { type NativeTabNavigationState } from '../lib/native-shell-layout'
import { TABS } from '../lib/tabs'

type IphoneNativeTabBarProps = {
  activeTintColor: string
  bottomInset: number
  inactiveTintColor: string
  navigationState: NativeTabNavigationState
  onIndexChange: (index: number) => void
}

/**
 * Keep iOS navigation in the native tab controller. Its transparent
 * scroll-edge appearance lets the page-matched native root supply the backdrop
 * without the controller adding a separate tinted slab behind the glass bar.
 */
export const IphoneNativeTabBar = ({
  activeTintColor,
  bottomInset,
  inactiveTintColor,
  navigationState,
  onIndexChange,
}: IphoneNativeTabBarProps): React.JSX.Element => (
  <View style={[styles.host, { height: getIphoneTabBarHostHeight(bottomInset) }]}>
    <TabView
      getIcon={({ route }) => {
        const tab = TABS.find((item) => item.key === route.key)
        return tab ? { sfSymbol: tab.sfSymbol } : undefined
      }}
      navigationState={navigationState}
      onIndexChange={onIndexChange}
      renderScene={() => <View style={styles.scene} />}
      scrollEdgeAppearance="transparent"
      tabBarActiveTintColor={activeTintColor}
      tabBarInactiveTintColor={inactiveTintColor}
      translucent
    />
  </View>
)

const styles = StyleSheet.create({
  host: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 20,
  },
  scene: { flex: 1 },
})
