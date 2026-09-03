import { Pressable, StyleSheet, Text, View } from 'react-native'

import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'
import { NativeIdentityAvatar } from './NativeTeamAvatar'

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

const ACCOUNT_AVATAR_SIZE = 32

const PresenceBadge = ({
  focusModeEnabled,
  presence,
  theme,
}: Pick<IpadNativeAccountButtonProps, 'focusModeEnabled' | 'presence' | 'theme'>): React.JSX.Element => {
  const dot = focusModeEnabled
    ? { backgroundColor: '#ffffff' }
    : presence === 'online'
    ? { backgroundColor: '#20a86b' }
    : presence === 'away'
      ? { backgroundColor: '#e6a323' }
      : { backgroundColor: theme.backgroundColor, borderColor: theme.inactiveTintColor, borderWidth: 1.5 }

  return (
    <View style={[styles.presenceRing, { backgroundColor: theme.backgroundColor }]}>
      <View style={[styles.presenceDot, dot]}>
        {focusModeEnabled ? <View style={styles.focusPresenceDash} /> : null}
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
    <NativeIdentityAvatar
      backgroundColor={theme.activeTintColor}
      imageUrl={avatarUrl}
      initialsFallback="U"
      label={name ?? ''}
      shape="circle"
      size={ACCOUNT_AVATAR_SIZE}
      textColor="#ffffff"
    />
    {statusEmoji ? (
      <View style={[styles.statusBadge, { backgroundColor: theme.backgroundColor }]}>
        <Text style={styles.statusEmoji}>{statusEmoji}</Text>
      </View>
    ) : null}
    <PresenceBadge focusModeEnabled={focusModeEnabled} presence={presence} theme={theme} />
  </Pressable>
)

const styles = StyleSheet.create({
  awayMark: { color: '#2b2018', fontSize: 8, fontWeight: '700', lineHeight: 9 },
  focusPresenceDash: {
    borderColor: '#20a86b',
    borderRadius: 4,
    borderStyle: 'dashed',
    borderWidth: 1,
    bottom: 1,
    left: 1,
    position: 'absolute',
    right: 1,
    top: 1,
  },
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
