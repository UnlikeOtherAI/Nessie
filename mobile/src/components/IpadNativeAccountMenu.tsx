import { Image, Pressable, StyleSheet, Text, View } from 'react-native'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

type IpadNativeAccountMenuProps = {
  avatarUrl: string | null
  left: number
  name: string | null
  onPress: () => void
  presence: 'away' | 'offline' | 'online'
  statusEmoji: string | null
  theme: IpadNativeChromeTheme
  top: number
}

const initial = (name: string | null): string => [...(name?.trim() ?? '')][0]?.toUpperCase() ?? 'U'

const PresenceBadge = ({
  presence,
  theme,
}: Pick<IpadNativeAccountMenuProps, 'presence' | 'theme'>): React.JSX.Element => {
  const dot = presence === 'online'
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
export const IpadNativeAccountMenu = ({
  avatarUrl,
  left,
  name,
  onPress,
  presence,
  statusEmoji,
  theme,
  top,
}: IpadNativeAccountMenuProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { left, top }]}>
    <IpadNativeChromeSurface style={styles.surface} theme={theme}>
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
        <PresenceBadge presence={presence} theme={theme} />
      </Pressable>
    </IpadNativeChromeSurface>
  </View>
)

const styles = StyleSheet.create({
  avatar: { borderRadius: 16, height: 32, width: 32 },
  awayMark: { color: '#2b2018', fontSize: 8, fontWeight: '700', lineHeight: 9 },
  fallback: { alignItems: 'center', borderRadius: 16, height: 32, justifyContent: 'center', width: 32 },
  initial: { color: '#fff', fontSize: 12, fontWeight: '700' },
  layer: { position: 'absolute', zIndex: 20 },
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
  surface: { width: 42 },
  trigger: { alignItems: 'center', borderRadius: 17, height: 34, justifyContent: 'center', width: 34 },
})
