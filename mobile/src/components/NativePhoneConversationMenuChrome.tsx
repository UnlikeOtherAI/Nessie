import { useEffect, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { withOpacity } from '../lib/ipad-native-chrome'
import {
  getNativePhoneBottomChromeClearance,
  getNativePhoneComposeBottom,
  NATIVE_PHONE_MENU_HEADER_HEIGHT,
  type NativePhoneCreationAction,
} from '../lib/native-shell-layout'

type NativePhoneConversationMenuChromeProps = {
  accentColor: string
  accountAvatarUrl: string | null
  accountName: string | null
  accountPresence: 'away' | 'offline' | 'online'
  bottomInset: number
  creationAccentColor: string
  headerSurface: string
  headerText: string
  onAccentColor: string
  onAccountPress: () => void
  onHistoryPress: () => void
  onCreateAction: (action: NativePhoneCreationAction) => void
  safeTop: number
  sheetMutedText: string
  sheetSurface: string
  sheetText: string
  showCreationActions: boolean
  platform: 'android' | 'ios'
  onWorkspacePress: () => void
  workspaceName: string | null
}

const initial = (label: string | null, fallback: string): string =>
  [...(label?.trim() ?? '')][0]?.toUpperCase() ?? fallback

const creationHeading = 'Start a new channel, project, or direct message'

const AccountPresenceIndicator = ({
  headerSurface,
  headerText,
  state,
}: {
  headerSurface: string
  headerText: string
  state: 'away' | 'offline' | 'online'
}): React.JSX.Element => {
  const dotStyle = state === 'online'
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

/**
 * Native phone shell chrome for every tab's first screen. The controls are
 * native but delegate to the WebView's existing workspace, recents, account,
 * and compose actions, preserving their authorization and menus.
 */
export const NativePhoneConversationMenuChrome = ({
  accentColor,
  accountAvatarUrl,
  accountName,
  accountPresence,
  bottomInset,
  creationAccentColor,
  headerSurface,
  headerText,
  onAccentColor,
  onAccountPress,
  onHistoryPress,
  onCreateAction,
  safeTop,
  sheetMutedText,
  sheetSurface,
  sheetText,
  showCreationActions,
  platform,
  onWorkspacePress,
  workspaceName,
}: NativePhoneConversationMenuChromeProps): React.JSX.Element => {
  const [creationOpen, setCreationOpen] = useState(false)
  useEffect(() => {
    if (!showCreationActions) setCreationOpen(false)
  }, [showCreationActions])

  const selectCreationAction = (action: NativePhoneCreationAction): void => {
    setCreationOpen(false)
    onCreateAction(action)
  }

  return (
    <>
    <View
      pointerEvents="box-none"
      style={[styles.header, { backgroundColor: headerSurface, height: safeTop + NATIVE_PHONE_MENU_HEADER_HEIGHT }]}
    >
      <View style={[styles.headerContent, { paddingTop: safeTop }]}>
        <Pressable
          accessibilityLabel={`Switch workspace, ${workspaceName ?? 'Workspace'}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onWorkspacePress}
          style={({ pressed }) => [
            styles.workspace,
            pressed ? { backgroundColor: withOpacity(headerText, 0.14) } : null,
          ]}
        >
          <View style={[styles.workspaceAvatar, { backgroundColor: withOpacity(accentColor, 0.45) }]}>
            <Text style={[styles.workspaceInitial, { color: headerText }]}>{initial(workspaceName, 'W')}</Text>
          </View>
          <Text numberOfLines={1} style={[styles.workspaceName, { color: headerText }]}>
            {workspaceName ?? 'Workspace'}
          </Text>
          <MaterialIcons color={headerText} name="keyboard-arrow-down" size={24} />
        </Pressable>

        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel="Recent channels"
            accessibilityRole="button"
            hitSlop={6}
            onPress={onHistoryPress}
            style={({ pressed }) => [
              styles.historyButton,
              { backgroundColor: withOpacity(headerText, 0.12) },
              pressed ? { backgroundColor: withOpacity(headerText, 0.22) } : null,
            ]}
          >
            <MaterialIcons color={headerText} name="history" size={25} />
          </Pressable>
          <Pressable
            accessibilityLabel="Account menu"
            accessibilityRole="button"
            hitSlop={6}
            onPress={onAccountPress}
            style={({ pressed }) => [
              styles.accountButton,
              { borderColor: withOpacity(headerText, 0.38) },
              pressed ? { opacity: 0.8 } : null,
            ]}
          >
            {accountAvatarUrl ? (
              <Image source={{ uri: accountAvatarUrl }} style={styles.accountAvatar} />
            ) : (
              <View style={[styles.accountFallback, { backgroundColor: withOpacity(headerText, 0.18) }]}>
                <Text style={[styles.accountInitial, { color: headerText }]}>{initial(accountName, 'U')}</Text>
              </View>
            )}
            <AccountPresenceIndicator
              headerSurface={headerSurface}
              headerText={headerText}
              state={accountPresence}
            />
          </Pressable>
        </View>
      </View>
    </View>

    {showCreationActions && !creationOpen ? (
      <Pressable
        accessibilityLabel="Start a new channel, project, or direct message"
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => setCreationOpen(true)}
        style={({ pressed }) => [
          styles.composeButton,
          {
            backgroundColor: creationAccentColor,
            bottom: getNativePhoneComposeBottom(bottomInset, platform),
          },
          pressed ? styles.composeButtonPressed : null,
        ]}
      >
        <Text style={[styles.composeSymbol, { color: onAccentColor }]}>+</Text>
      </Pressable>
    ) : null}
    {showCreationActions && creationOpen ? (
      <>
        <Pressable
          accessibilityLabel="Close create menu"
          onPress={() => setCreationOpen(false)}
          style={styles.createBackdrop}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.createSheet,
            {
              backgroundColor: withOpacity(sheetSurface, 0.98),
              borderColor: withOpacity(sheetText, 0.16),
              bottom: bottomInset + getNativePhoneBottomChromeClearance(platform) + 8,
            },
          ]}
        >
          <Text style={[styles.createHeading, { color: sheetText }]}>{creationHeading}</Text>
          <Pressable
            accessibilityLabel="Create project"
            accessibilityRole="button"
            onPress={() => selectCreationAction('project')}
            style={({ pressed }) => [
              styles.createRow,
              pressed ? { backgroundColor: withOpacity(sheetText, 0.07) } : null,
            ]}
          >
            <View style={[styles.createIcon, { backgroundColor: withOpacity(creationAccentColor, 0.12) }]}>
              <MaterialIcons color={creationAccentColor} name="folder" size={28} />
            </View>
            <View style={styles.createCopy}>
              <Text style={[styles.createTitle, { color: sheetText }]}>Project</Text>
              <Text style={[styles.createDescription, { color: sheetMutedText }]}>
                Organise work in a shared folder
              </Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel="Create channel"
            accessibilityRole="button"
            onPress={() => selectCreationAction('channel')}
            style={({ pressed }) => [
              styles.createRow,
              pressed ? { backgroundColor: withOpacity(sheetText, 0.07) } : null,
            ]}
          >
            <View style={[styles.createIcon, { backgroundColor: withOpacity(creationAccentColor, 0.12) }]}>
              <MaterialIcons color={creationAccentColor} name="tag" size={28} />
            </View>
            <View style={styles.createCopy}>
              <Text style={[styles.createTitle, { color: sheetText }]}>Channel</Text>
              <Text style={[styles.createDescription, { color: sheetMutedText }]}>Start a team conversation</Text>
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel="Start a direct message"
            accessibilityRole="button"
            onPress={() => selectCreationAction('message')}
            style={({ pressed }) => [
              styles.messageAction,
              { backgroundColor: creationAccentColor },
              pressed ? styles.messageActionPressed : null,
            ]}
          >
            <MaterialIcons color={onAccentColor} name="edit" size={26} />
            <Text style={[styles.messageActionText, { color: onAccentColor }]}>Message</Text>
          </Pressable>
        </View>
      </>
    ) : null}
  </>
  )
}

const styles = StyleSheet.create({
  accountAvatar: { borderRadius: 19, height: 38, width: 38 },
  accountButton: {
    height: 42,
    width: 42,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
    borderRadius: 21,
    borderWidth: 1,
  },
  accountFallback: {
    height: 38,
    width: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
  },
  accountInitial: { fontSize: 16, fontWeight: '700' },
  composeButton: {
    position: 'absolute',
    right: 22,
    zIndex: 30,
    height: 62,
    width: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 31,
    shadowColor: '#000',
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
  },
  composeButtonPressed: { transform: [{ scale: 0.94 }] },
  composeSymbol: { fontSize: 38, fontWeight: '300', lineHeight: 42 },
  createBackdrop: { ...StyleSheet.absoluteFillObject, zIndex: 39 },
  createCopy: { flex: 1, gap: 2 },
  createDescription: { fontSize: 16, lineHeight: 20 },
  createHeading: { fontSize: 17, fontWeight: '700', lineHeight: 22, paddingHorizontal: 10, paddingTop: 4 },
  createIcon: { alignItems: 'center', borderRadius: 12, height: 52, justifyContent: 'center', width: 52 },
  createRow: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 14, padding: 10 },
  createSheet: {
    position: 'absolute',
    zIndex: 40,
    left: 16,
    right: 16,
    gap: 6,
    borderRadius: 28,
    borderWidth: 1,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
  },
  createTitle: { fontSize: 22, fontWeight: '700', lineHeight: 26 },
  header: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 30 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  headerContent: {
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  historyButton: { alignItems: 'center', borderRadius: 21, height: 42, justifyContent: 'center', width: 42 },
  messageAction: {
    alignItems: 'center',
    borderRadius: 24,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    marginTop: 4,
    minHeight: 58,
  },
  messageActionPressed: { opacity: 0.84 },
  messageActionText: { fontSize: 23, fontWeight: '700' },
  presenceCutout: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    height: 13,
    width: 13,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presenceDot: {
    height: 7,
    width: 7,
    borderRadius: 4,
  },
  workspace: {
    alignItems: 'center',
    borderRadius: 22,
    flexDirection: 'row',
    gap: 8,
    maxWidth: '58%',
    paddingHorizontal: 4,
  },
  workspaceAvatar: { alignItems: 'center', borderRadius: 15, height: 30, justifyContent: 'center', width: 30 },
  workspaceInitial: { fontSize: 14, fontWeight: '700' },
  workspaceName: { flexShrink: 1, fontSize: 21, fontWeight: '700' },
})
