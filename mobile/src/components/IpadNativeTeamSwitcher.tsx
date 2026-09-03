import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { NativeTeamAvatar } from './NativeTeamAvatar'
import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

type IpadNativeTeamSwitcherProps = {
  left: number
  maxWidth: number
  name: string
  imageUrl: string | null
  onPress: () => void
  theme: IpadNativeChromeTheme
  top: number
}

export const IpadNativeTeamSwitcher = ({
  imageUrl,
  left,
  maxWidth,
  name,
  onPress,
  theme,
  top,
}: IpadNativeTeamSwitcherProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { left, top }]}>
    <IpadNativeChromeSurface theme={theme}>
      <Pressable
        accessibilityLabel={`Switch team, ${name}`}
        accessibilityRole="button"
        hitSlop={4}
        onPress={onPress}
        style={({ pressed }) => [
          styles.trigger,
          { maxWidth: maxWidth - 8 },
          pressed ? { backgroundColor: theme.pressedBackgroundColor } : null,
        ]}
      >
        <NativeTeamAvatar
          backgroundColor={theme.activeBackgroundColor}
          imageUrl={imageUrl}
          label={name}
          size={28}
          textColor={theme.activeTintColor}
        />
        <Text numberOfLines={1} style={[styles.name, { color: theme.inactiveTintColor }]}>
          {name}
        </Text>
        <MaterialIcons color={theme.inactiveTintColor} name="keyboard-arrow-down" size={20} />
      </Pressable>
    </IpadNativeChromeSurface>
  </View>
)

const styles = StyleSheet.create({
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
