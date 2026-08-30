import { Image, Pressable, StyleSheet, Text, View } from 'react-native'

import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

export type IpadNativeAccount = {
  avatarUrl: string | null
  focusModeEnabled: boolean
  name: string | null
  presence: 'away' | 'offline' | 'online'
  statusEmoji: string | null
}

type IpadNativeAccountButtonProps = IpadNativeAccount & {
  onPress: () => void
  theme: IpadNativeChromeTheme
}

const initial = (name: string | null): string => [...(name?.trim() ?? '')][0]?.toUpperCase() ?? 'U'

const PresenceBadge = ({
  focusModeEnabled,
  presence,
  theme,
}: Pick<IpadNativeAccountButtonProps, 'focusModeEnabled' | 'presence' | 'theme'>): React.JSX.Element => {
  const dot = focusModeEnabled
    ? { backgroundColor: '#ffffff', borderColor: '#20a86b', borderStyle: 'dashed' as const, borderWidth: 1.5 }
    : presence === 'online'
    ? { backgroundColor: '#20a86b' }
    : presence === 'away'
      ? { backgroundColor: '#e6a323' }
      : { backgroundColor: theme.backgroundColor, borderColor: theme.inactiveTintColor, borderWidth: 1.5 }

  return (
    <View style={[styles.presenceRing, { backgroundColor: theme.backgroundColor }]}>
      <View style={[styles.presenceDot, dot]}>
        {presence === 'away' ? <Text style={styles.awayMark}>z</Text> : null}
      </View>
    </View>
  )
}

// This is the native presentation of the web account trigger. Its press
// delegates to the WebView, which keeps the same account menu and actions.
export const IpadNativeAccountButton = ({
  avatarUrl,
  focusModeEnabled,
  name,
  onPress,
  presence,
  statusEmoji,
  theme,
}: IpadNativeAccountButtonProps): React.JSX.Element => (
  <Pressable
    accessibilityLabel="Account menu"
    accessibilityRole="button"
    hitSlop={4}
    onPress={onPress}
    style={({ pressed }) => [
      styles.trigger,
      pressed ? { backgroundColor: theme.pressedBackgroundColor } : null,
    ]}
  >
    {avatarUrl ? (
      <Image accessibilityLabel={name ?? 'User'} source={{ uri: avatarUrl }} style={styles.avatar} />
    ) : (
      <View style={[styles.fallback, { backgroundColor: theme.activeTintColor }]}>
        <Text style={styles.initial}>{initial(name)}</Text>
      </View>
    )}
    {statusEmoji ? (
      <View style={[styles.statusBadge, { backgroundColor: theme.backgroundColor }]}>
        <Text style={styles.statusEmoji}>{statusEmoji}</Text>
      </View>
    ) : null}
    <PresenceBadge focusModeEnabled={focusModeEnabled} presence={presence} theme={theme} />
  </Pressable>
)

const styles = StyleSheet.create({
  avatar: { borderRadius: 16, height: 32, width: 32 },
  awayMark: { color: '#2b2018', fontSize: 8, fontWeight: '700', lineHeight: 9 },
  fallback: { alignItems: 'center', borderRadius: 16, height: 32, justifyContent: 'center', width: 32 },
  initial: { color: '#fff', fontSize: 12, fontWeight: '700' },
  presenceDot: { alignItems: 'center', borderRadius: 5, height: 10, justifyContent: 'center', width: 10 },
  presenceRing: {
    alignItems: 'center',
    borderRadius: 7,
    bottom: -1,
    height: 14,
    justifyContent: 'center',
    position: 'absolute',
    right: -1,
    width: 14,
  },
  statusBadge: {
    alignItems: 'center',
    borderRadius: 8,
    height: 16,
    justifyContent: 'center',
    position: 'absolute',
    right: -4,
    top: -4,
    width: 16,
  },
  statusEmoji: { fontSize: 10, lineHeight: 12 },
  trigger: { alignItems: 'center', borderRadius: 17, height: 34, justifyContent: 'center', width: 34 },
})
