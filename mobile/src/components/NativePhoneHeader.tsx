import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { NativeWorkspaceAvatar } from './NativeWorkspaceAvatar'
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
  onToolbarAction: (action: ToolbarAction) => void
  onWorkspacePress: () => void
  safeTop: number
  toolbarState: ToolbarState
  workspaceAvatarUrl: string | null
  workspaceName: string | null
}

const initial = (label: string | null, fallback: string): string =>
  [...(label?.trim() ?? '')][0]?.toUpperCase() ?? fallback

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
    ? { backgroundColor: '#ffffff', borderColor: '#20a86b', borderStyle: 'dashed' as const, borderWidth: 1.5 }
    : state === 'online'
    ? { backgroundColor: '#20a86b' }
    : state === 'away'
      ? { backgroundColor: '#e6a323' }
      : { backgroundColor: headerSurface, borderColor: withOpacity(headerText, 0.62), borderWidth: 1.5 }

  return (
    <View style={[styles.presenceCutout, { backgroundColor: headerSurface }]}>
      <View style={[styles.presenceDot, dotStyle]} />
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

// Portrait reserves this bar for workspace identity and account access. A
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
  onToolbarAction,
  onWorkspacePress,
  safeTop,
  toolbarState,
  workspaceAvatarUrl,
  workspaceName,
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
          accessibilityLabel={`Switch workspace, ${workspaceName ?? 'Workspace'}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onWorkspacePress}
          style={({ pressed }) => [
            styles.workspace,
            compact ? styles.workspaceCompact : null,
            pressed ? { backgroundColor: withOpacity(headerText, 0.14) } : null,
          ]}
        >
          <NativeWorkspaceAvatar
            backgroundColor={withOpacity(accentColor, 0.45)}
            imageUrl={workspaceAvatarUrl}
            label={workspaceName ?? 'Workspace'}
            size={compact ? 26 : 30}
            textColor={headerText}
          />
          <Text
            numberOfLines={1}
            style={[styles.workspaceName, compact ? styles.workspaceNameCompact : null, { color: headerText }]}
          >
            {workspaceName ?? 'Workspace'}
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
          {accountAvatarUrl ? (
            <Image
              source={{ uri: accountAvatarUrl }}
              style={{ borderRadius: avatarDiameter / 2, height: avatarDiameter, width: avatarDiameter }}
            />
          ) : (
            <View
              style={[
                styles.accountFallback,
                {
                  backgroundColor: withOpacity(headerText, 0.18),
                  borderRadius: avatarDiameter / 2,
                  height: avatarDiameter,
                  width: avatarDiameter,
                },
              ]}
            >
              <Text style={[styles.accountInitial, { color: headerText }]}>{initial(accountName, 'U')}</Text>
            </View>
          )}
          <AccountPresenceIndicator
            focusModeEnabled={accountFocusModeEnabled}
            headerSurface={headerSurface}
            headerText={headerText}
            state={accountPresence}
          />
        </Pressable>
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
  workspace: {
    alignItems: 'center',
    borderRadius: 22,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    minWidth: 0,
    paddingHorizontal: 4,
  },
  workspaceCompact: { gap: 6, paddingHorizontal: 2 },
  workspaceName: { flexShrink: 1, fontSize: 21, fontWeight: '700' },
  workspaceNameCompact: { fontSize: 17 },
})
