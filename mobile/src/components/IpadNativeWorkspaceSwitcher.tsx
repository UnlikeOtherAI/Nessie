import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

type IpadNativeWorkspaceSwitcherProps = {
  left: number
  maxWidth: number
  name: string
  onPress: () => void
  theme: IpadNativeChromeTheme
  top: number
}

const workspaceInitial = (name: string): string => [...name.trim()][0]?.toUpperCase() ?? 'W'

export const IpadNativeWorkspaceSwitcher = ({
  left,
  maxWidth,
  name,
  onPress,
  theme,
  top,
}: IpadNativeWorkspaceSwitcherProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { left, top }]}>
    <IpadNativeChromeSurface theme={theme}>
      <Pressable
        accessibilityLabel={`Switch workspace, ${name}`}
        accessibilityRole="button"
        hitSlop={4}
        onPress={onPress}
        style={({ pressed }) => [
          styles.trigger,
          { maxWidth: maxWidth - 8 },
          pressed ? { backgroundColor: theme.pressedBackgroundColor } : null,
        ]}
      >
        <View style={[styles.avatar, { backgroundColor: theme.activeBackgroundColor }]}>
          <Text style={[styles.avatarLabel, { color: theme.activeTintColor }]}>
            {workspaceInitial(name)}
          </Text>
        </View>
        <Text numberOfLines={1} style={[styles.name, { color: theme.inactiveTintColor }]}>
          {name}
        </Text>
        <MaterialIcons color={theme.inactiveTintColor} name="keyboard-arrow-down" size={20} />
      </Pressable>
    </IpadNativeChromeSurface>
  </View>
)

const styles = StyleSheet.create({
  avatar: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  avatarLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  layer: {
    position: 'absolute',
    zIndex: 20,
  },
  name: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  trigger: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    borderRadius: 17,
  },
})
