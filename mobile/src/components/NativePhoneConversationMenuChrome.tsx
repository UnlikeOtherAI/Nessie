import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { NativeWorkspaceAvatar } from './NativeWorkspaceAvatar'
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
  workspaceAvatarUrl: string | null
  workspaceName: string | null
}

const initial = (label: string | null, fallback: string): string =>
  [...(label?.trim() ?? '')][0]?.toUpperCase() ?? fallback

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

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
  workspaceAvatarUrl,
  workspaceName,
}: NativePhoneConversationMenuChromeProps): React.JSX.Element => {
  const [creationOpen, setCreationOpen] = useState(false)
  const creationProgress = useRef(new Animated.Value(0)).current
  const { width: windowWidth } = useWindowDimensions()

  useEffect(() => {
    if (showCreationActions) return
    creationProgress.stopAnimation()
    creationProgress.setValue(0)
    setCreationOpen(false)
  }, [creationProgress, showCreationActions])

  const openCreationMenu = (): void => {
    creationProgress.stopAnimation()
    creationProgress.setValue(0)
    setCreationOpen(true)
    requestAnimationFrame(() => {
      Animated.timing(creationProgress, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: false,
      }).start()
    })
  }

  const closeCreationMenu = (): void => {
    Animated.timing(creationProgress, {
      duration: 180,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) setCreationOpen(false)
    })
  }

  const selectCreationAction = (action: NativePhoneCreationAction): void => {
    creationProgress.stopAnimation()
    creationProgress.setValue(0)
    setCreationOpen(false)
    onCreateAction(action)
  }

  const createSheetBottom = bottomInset + getNativePhoneBottomChromeClearance(platform) + 8
  const initialComposeBottom = getNativePhoneComposeBottom(bottomInset, platform)
  const messageActionWidth = Math.max(62, windowWidth - 48)
  const sheetAnimation = {
    opacity: creationProgress,
    transform: [
      { translateX: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [116, 0] }) },
      { translateY: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [96, 0] }) },
      { scale: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) },
    ],
  }
  const optionsAnimation = {
    opacity: creationProgress.interpolate({ inputRange: [0, 0.44, 1], outputRange: [0, 0, 1] }),
    transform: [
      { translateY: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) },
    ],
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
          <NativeWorkspaceAvatar
            backgroundColor={withOpacity(accentColor, 0.45)}
            imageUrl={workspaceAvatarUrl}
            label={workspaceName ?? 'Workspace'}
            size={30}
            textColor={headerText}
          />
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

    {showCreationActions ? (
      <AnimatedPressable
        accessibilityLabel={creationOpen ? 'Start a direct message' : 'Open creation menu'}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => {
          if (creationOpen) selectCreationAction('message')
          else openCreationMenu()
        }}
        style={[
          styles.morphingMessageAction,
          {
            backgroundColor: creationAccentColor,
            bottom: creationProgress.interpolate({
              inputRange: [0, 1],
              outputRange: [initialComposeBottom, createSheetBottom + 8],
            }),
            borderRadius: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [31, 16] }),
            height: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [62, 38] }),
            right: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [22, 24] }),
            width: creationProgress.interpolate({ inputRange: [0, 1], outputRange: [62, messageActionWidth] }),
          },
        ]}
      >
        <Animated.Text
          style={[
            styles.composeSymbol,
            {
              color: onAccentColor,
              opacity: creationProgress.interpolate({ inputRange: [0, 0.52, 1], outputRange: [1, 0, 0] }),
            },
          ]}
        >
          +
        </Animated.Text>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.morphingMessageContent,
            {
              opacity: creationProgress.interpolate({ inputRange: [0, 0.38, 1], outputRange: [0, 0, 1] }),
            },
          ]}
        >
          <MaterialIcons color={onAccentColor} name="edit" size={17} />
          <Text style={[styles.messageActionText, { color: onAccentColor }]}>Message</Text>
        </Animated.View>
      </AnimatedPressable>
    ) : null}
    {showCreationActions && creationOpen ? (
      <>
        <Pressable
          accessibilityLabel="Close create menu"
          onPress={closeCreationMenu}
          style={styles.createBackdrop}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.createSheet,
            {
              backgroundColor: withOpacity(sheetSurface, 0.98),
              borderColor: withOpacity(sheetText, 0.16),
              bottom: createSheetBottom,
            },
            sheetAnimation,
          ]}
        >
          <Animated.View style={[styles.createOptions, optionsAnimation]}>
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
                <MaterialIcons color={creationAccentColor} name="folder" size={18} />
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
                <MaterialIcons color={creationAccentColor} name="tag" size={18} />
              </View>
              <View style={styles.createCopy}>
                <Text style={[styles.createTitle, { color: sheetText }]}>Channel</Text>
                <Text style={[styles.createDescription, { color: sheetMutedText }]}>Start a team conversation</Text>
              </View>
            </Pressable>
          </Animated.View>
          <View style={styles.messageActionSlot} />
        </Animated.View>
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
  morphingMessageAction: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    zIndex: 42,
  },
  morphingMessageContent: { alignItems: 'center', flexDirection: 'row', gap: 7, justifyContent: 'center' },
  composeSymbol: { fontSize: 38, fontWeight: '300', lineHeight: 42, position: 'absolute' },
  createBackdrop: { ...StyleSheet.absoluteFillObject, zIndex: 39 },
  createCopy: { flex: 1, gap: 1 },
  createDescription: { fontSize: 10, lineHeight: 13 },
  createIcon: { alignItems: 'center', borderRadius: 8, height: 34, justifyContent: 'center', width: 34 },
  createOptions: { gap: 4 },
  createRow: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', gap: 9, padding: 7 },
  createSheet: {
    position: 'absolute',
    zIndex: 40,
    left: 16,
    right: 16,
    gap: 4,
    borderRadius: 18,
    borderWidth: 1,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
  },
  createTitle: { fontSize: 14, fontWeight: '700', lineHeight: 17 },
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
  messageActionSlot: { height: 38 },
  messageActionText: { fontSize: 15, fontWeight: '700', lineHeight: 18 },
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
  workspaceName: { flexShrink: 1, fontSize: 21, fontWeight: '700' },
})
