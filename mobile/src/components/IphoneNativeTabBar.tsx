import { StyleSheet, View } from 'react-native'
import TabView from 'react-native-bottom-tabs'

import { type NativeTabNavigationState } from '../lib/native-shell-layout'
import { TABS } from '../lib/tabs'

type IphoneNativeTabBarProps = {
  activeTintColor: string
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
  inactiveTintColor,
  navigationState,
  onIndexChange,
}: IphoneNativeTabBarProps): React.JSX.Element => (
  <View style={StyleSheet.absoluteFill}>
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
  scene: { flex: 1 },
})
