import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

type NativeFocusModeButtonProps = {
  activeBackgroundColor: string
  activeTintColor: string
  enabled: boolean
  inactiveTintColor: string
  onPress: () => void
}

// The actual palette transition remains owned by the hosted web app. This
// native control mirrors its confirmed state and gives that 300ms transition a
// matching, restrained moon motion in the surrounding native chrome.
export const NativeFocusModeButton = ({
  activeBackgroundColor,
  activeTintColor,
  enabled,
  inactiveTintColor,
  onPress,
}: NativeFocusModeButtonProps): React.JSX.Element => {
  const progress = useRef(new Animated.Value(enabled ? 1 : 0)).current

  useEffect(() => {
    Animated.timing(progress, {
      duration: 300,
      toValue: enabled ? 1 : 0,
      useNativeDriver: true,
    }).start()
  }, [enabled, progress])

  return (
    <Pressable
      accessibilityLabel={enabled ? 'Turn off focus mode' : 'Turn on focus mode'}
      accessibilityRole="button"
      accessibilityState={{ selected: enabled }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: enabled ? activeBackgroundColor : 'transparent' },
        pressed ? styles.pressed : null,
      ]}
    >
      <Animated.View
        style={{
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.78, 1] }),
          transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['-16deg', '0deg'] }) }],
        }}
      >
        <MaterialIcons color={enabled ? activeTintColor : inactiveTintColor} name="dark-mode" size={20} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', borderRadius: 17, height: 34, justifyContent: 'center', width: 34 },
  pressed: { opacity: 0.76 },
})
