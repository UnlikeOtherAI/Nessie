import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { NativeFocusModeButton } from './NativeFocusModeButton'
import { NativeIdentityAvatar, NativeTeamAvatar } from './NativeTeamAvatar'
import { type ToolbarAction, type ToolbarState } from './native-toolbar-state'
import { withOpacity } from '../lib/ipad-native-chrome'
import {
  getNativePhoneHeaderHeight,
  NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER,
} from '../lib/native-shell-layout'

export type NativePhoneHeaderProps = {
  accentColor: string
  accountAvatarUrl: string | null
  accountFocusModeEnabled: boolean
  accountName: string | null
  accountPresence: 'away' | 'offline' | 'online'
  headerSurface: string
  headerText: string
  landscape: boolean
  onAccountPress: () => void
  onToggleFocusMode: () => void
  onToolbarAction: (action: ToolbarAction) => void
  onTeamPress: () => void
  safeTop: number
  toolbarState: ToolbarState
  teamAvatarUrl: string | null
  teamName: string | null
}

const AccountPresenceIndicator = ({
  focusModeEnabled,
  headerSurface,
  headerText,
  state,
}: {
  focusModeEnabled: boolean
  headerSurface: string
  headerText: string
  state: 'away' | 'offline' | 'online'
}): React.JSX.Element => {
  const dotStyle = focusModeEnabled
    ? { backgroundColor: '#ffffff' }
    : state === 'online'
    ? { backgroundColor: '#20a86b' }
    : state === 'away'
      ? { backgroundColor: '#e6a323' }
      : { backgroundColor: headerSurface, borderColor: withOpacity(headerText, 0.62), borderWidth: 1.5 }

  return (
    <View style={[styles.presenceCutout, { backgroundColor: headerSurface }]}>
      <View style={[styles.presenceDot, dotStyle]}>
        {focusModeEnabled ? <View style={styles.focusPresenceDash} /> : null}
      </View>
    </View>
  )
}

const NativePhoneToolbarControls = ({
  headerText,
  onToolbarAction,
  toolbarState,
}: Pick<NativePhoneHeaderProps, 'headerText' | 'onToolbarAction' | 'toolbarState'>): React.JSX.Element => (
  <View style={styles.toolbarControls}>
    <Pressable
      accessibilityLabel="Back"
      accessibilityRole="button"
      disabled={!toolbarState.canBack}
      hitSlop={6}
      onPress={() => onToolbarAction('back')}
      style={({ pressed }) => [
        styles.toolbarButton,
        { backgroundColor: withOpacity(headerText, 0.12) },
        !toolbarState.canBack ? styles.toolbarButtonDisabled : null,
        pressed && toolbarState.canBack ? { backgroundColor: withOpacity(headerText, 0.22) } : null,
      ]}
    >
      <MaterialIcons color={headerText} name="arrow-back-ios-new" size={16} />
    </Pressable>
    <Pressable
      accessibilityLabel="Forward"
      accessibilityRole="button"
      disabled={!toolbarState.canForward}
      hitSlop={6}
      onPress={() => onToolbarAction('forward')}
      style={({ pressed }) => [
        styles.toolbarButton,
        { backgroundColor: withOpacity(headerText, 0.12) },
        !toolbarState.canForward ? styles.toolbarButtonDisabled : null,
        pressed && toolbarState.canForward ? { backgroundColor: withOpacity(headerText, 0.22) } : null,
      ]}
    >
      <MaterialIcons color={headerText} name="arrow-forward-ios" size={16} />
    </Pressable>
    <Pressable
      accessibilityLabel="Recent channels"
      accessibilityRole="button"
      hitSlop={6}
      onPress={() => onToolbarAction('history')}
      style={({ pressed }) => [
        styles.historyButton,
        { backgroundColor: withOpacity(headerText, 0.12) },
        toolbarState.recentOpen ? { backgroundColor: withOpacity(headerText, 0.22) } : null,
        pressed ? { backgroundColor: withOpacity(headerText, 0.3) } : null,
      ]}
    >
      <MaterialIcons color={headerText} name="history" size={21} />
    </Pressable>
  </View>
)

// Portrait reserves this bar for team identity and account access. A
// Max-class iPhone in landscape gains the navigation controls between them,
// where its wider but shorter canvas can carry them without crowding content.
export const NativePhoneHeader = ({
  accentColor,
  accountAvatarUrl,
  accountFocusModeEnabled,
  accountName,
  accountPresence,
  headerSurface,
  headerText,
  landscape,
  onAccountPress,
  onToggleFocusMode,
  onToolbarAction,
  onTeamPress,
  safeTop,
  toolbarState,
  teamAvatarUrl,
  teamName,
}: NativePhoneHeaderProps): React.JSX.Element => {
  const compact = landscape
  const accountDiameter = compact ? 36 : 42
  const avatarDiameter = compact ? 32 : 38

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.header,
        { backgroundColor: headerSurface, height: safeTop + getNativePhoneHeaderHeight(landscape) },
      ]}
    >
      <View style={[styles.headerContent, { paddingTop: safeTop }, compact ? styles.headerContentCompact : null]}>
        <Pressable
          accessibilityLabel={`Switch team, ${teamName ?? 'Team'}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onTeamPress}
          style={({ pressed }) => [
            styles.team,
            compact ? styles.teamCompact : null,
            pressed ? { backgroundColor: withOpacity(headerText, 0.14) } : null,
          ]}
        >
          <NativeTeamAvatar
            backgroundColor={withOpacity(accentColor, 0.45)}
            imageUrl={teamAvatarUrl}
            label={teamName ?? 'Team'}
            size={compact ? 26 : 30}
            textColor={headerText}
          />
          <Text
            numberOfLines={1}
            style={[styles.teamName, compact ? styles.teamNameCompact : null, { color: headerText }]}
          >
            {teamName ?? 'Team'}
          </Text>
          <MaterialIcons color={headerText} name="keyboard-arrow-down" size={compact ? 20 : 24} />
        </Pressable>

        {landscape ? (
          <NativePhoneToolbarControls
            headerText={headerText}
            onToolbarAction={onToolbarAction}
            toolbarState={toolbarState}
          />
        ) : null}

        <View style={styles.accountControls}>
          <NativeFocusModeButton
            activeBackgroundColor={withOpacity(headerText, 0.16)}
            activeTintColor={headerText}
            enabled={accountFocusModeEnabled}
            inactiveTintColor={withOpacity(headerText, 0.78)}
            onPress={onToggleFocusMode}
          />
          <Pressable
            accessibilityLabel="Account menu"
            accessibilityRole="button"
            hitSlop={6}
            onPress={onAccountPress}
            style={({ pressed }) => [
              styles.accountButton,
              {
                borderColor: withOpacity(headerText, 0.38),
                height: accountDiameter,
                width: accountDiameter,
              },
              pressed ? { opacity: 0.8 } : null,
            ]}
          >
          <NativeIdentityAvatar
            backgroundColor={withOpacity(headerText, 0.18)}
            imageUrl={accountAvatarUrl}
            initialsFallback="U"
            label={accountName ?? ''}
            shape="circle"
            size={avatarDiameter}
            textColor={headerText}
          />
          <AccountPresenceIndicator
            focusModeEnabled={accountFocusModeEnabled}
            headerSurface={headerSurface}
            headerText={headerText}
            state={accountPresence}
          />
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  accountButton: {
    alignItems: 'center',
    borderRadius: 21,
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'visible',
  },
  accountControls: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  accountFallback: { alignItems: 'center', justifyContent: 'center' },
  accountInitial: { fontSize: 16, fontWeight: '700' },
  header: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 30 },
  headerContent: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    height: '100%',
    paddingHorizontal: 16,
  },
  headerContentCompact: { gap: 8, paddingHorizontal: NATIVE_PHONE_LANDSCAPE_HORIZONTAL_GUTTER },
  historyButton: { alignItems: 'center', borderRadius: 16, height: 32, justifyContent: 'center', width: 32 },
  focusPresenceDash: {
    borderColor: '#20a86b',
    borderRadius: 3,
    borderStyle: 'dashed',
    borderWidth: 1,
    bottom: 1,
    left: 1,
    position: 'absolute',
    right: 1,
    top: 1,
  },
  presenceCutout: {
    alignItems: 'center',
    borderRadius: 7,
    bottom: -1,
    height: 13,
    justifyContent: 'center',
    position: 'absolute',
    right: -1,
    width: 13,
  },
  presenceDot: { borderRadius: 4, height: 7, width: 7 },
  toolbarButton: { alignItems: 'center', borderRadius: 15, height: 30, justifyContent: 'center', width: 30 },
  toolbarButtonDisabled: { opacity: 0.3 },
  toolbarControls: { alignItems: 'center', flexDirection: 'row', gap: 3 },
  team: {
    alignItems: 'center',
    borderRadius: 22,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    minWidth: 0,
    paddingHorizontal: 4,
  },
  teamCompact: { gap: 6, paddingHorizontal: 2 },
  teamName: { flexShrink: 1, fontSize: 21, fontWeight: '700' },
  teamNameCompact: { fontSize: 17 },
})
