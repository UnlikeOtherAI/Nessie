import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { NativePhoneHeader, type NativePhoneHeaderProps } from './NativePhoneHeader'
import { withOpacity } from '../lib/ipad-native-chrome'
import {
  NATIVE_CREATION_OPTIONS,
  shouldDismissNativeCreationMenu,
} from '../lib/native-creation-menu'
import {
  getNativePhoneBottomChromeClearance,
  getNativePhoneComposeBottom,
  type NativePhoneCreationAction,
} from '../lib/native-shell-layout'

type NativePhoneConversationMenuChromeProps = NativePhoneHeaderProps & {
  bottomInset: number
  creationAccentColor: string
  dismissCreationMenuVersion: number
  onAccentColor: string
  onCreationMenuOpen: () => void
  onCreateAction: (action: NativePhoneCreationAction) => void
  sheetMutedText: string
  sheetSurface: string
  sheetText: string
  showCreationActions: boolean
  platform: 'android' | 'ios'
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * Native phone shell chrome for every tab's first screen. The controls are
 * native but delegate to the WebView's existing workspace, recents, account,
 * and compose actions, preserving their authorization and menus.
 */
export const NativePhoneConversationMenuChrome = ({
  accentColor,
  accountAvatarUrl,
  accountFocusModeEnabled,
  accountName,
  accountPresence,
  bottomInset,
  creationAccentColor,
  dismissCreationMenuVersion,
  headerSurface,
  headerText,
  landscape,
  onAccentColor,
  onAccountPress,
  onToggleFocusMode,
  onCreationMenuOpen,
  onToolbarAction,
  onCreateAction,
  safeTop,
  sheetMutedText,
  sheetSurface,
  sheetText,
  showCreationActions,
  toolbarState,
  platform,
  onWorkspacePress,
  workspaceAvatarUrl,
  workspaceName,
}: NativePhoneConversationMenuChromeProps): React.JSX.Element => {
  const [creationOpen, setCreationOpen] = useState(false)
  const creationProgress = useRef(new Animated.Value(0)).current
  const dismissedCreationMenuVersion = useRef(dismissCreationMenuVersion)
  const { width: windowWidth } = useWindowDimensions()

  useEffect(() => {
    if (showCreationActions) return
    creationProgress.stopAnimation()
    creationProgress.setValue(0)
    setCreationOpen(false)
  }, [creationProgress, showCreationActions])

  const openCreationMenu = (): void => {
    onCreationMenuOpen()
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

  const closeCreationMenu = useCallback((): void => {
    Animated.timing(creationProgress, {
      duration: 180,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) setCreationOpen(false)
    })
  }, [creationProgress])

  useEffect(() => {
    const shouldClose = shouldDismissNativeCreationMenu({
      creationOpen,
      dismissVersion: dismissCreationMenuVersion,
      previousDismissVersion: dismissedCreationMenuVersion.current,
    })
    dismissedCreationMenuVersion.current = dismissCreationMenuVersion
    if (shouldClose) closeCreationMenu()
  }, [closeCreationMenu, creationOpen, dismissCreationMenuVersion])

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
      <NativePhoneHeader
        accentColor={accentColor}
        accountAvatarUrl={accountAvatarUrl}
        accountFocusModeEnabled={accountFocusModeEnabled}
        accountName={accountName}
        accountPresence={accountPresence}
        headerSurface={headerSurface}
        headerText={headerText}
        landscape={landscape}
        onAccountPress={onAccountPress}
        onToggleFocusMode={onToggleFocusMode}
        onToolbarAction={onToolbarAction}
        onWorkspacePress={onWorkspacePress}
        safeTop={safeTop}
        toolbarState={toolbarState}
        workspaceAvatarUrl={workspaceAvatarUrl}
        workspaceName={workspaceName}
      />

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
            {NATIVE_CREATION_OPTIONS.map((option) => (
              <Pressable
                accessibilityLabel={option.accessibilityLabel}
                accessibilityRole="button"
                key={option.action}
                onPress={() => selectCreationAction(option.action)}
                style={({ pressed }) => [
                  styles.createRow,
                  pressed ? { backgroundColor: withOpacity(sheetText, 0.07) } : null,
                ]}
              >
                <View style={[styles.createIcon, { backgroundColor: withOpacity(creationAccentColor, 0.12) }]}>
                  <MaterialIcons color={creationAccentColor} name={option.icon} size={18} />
                </View>
                <View style={styles.createCopy}>
                  <Text style={[styles.createTitle, { color: sheetText }]}>{option.title}</Text>
                  <Text style={[styles.createDescription, { color: sheetMutedText }]}>
                    {option.description}
                  </Text>
                </View>
              </Pressable>
            ))}
          </Animated.View>
          <View style={styles.messageActionSlot} />
        </Animated.View>
      </>
    ) : null}
  </>
  )
}

const styles = StyleSheet.create({
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
  messageActionSlot: { height: 38 },
  messageActionText: { fontSize: 15, fontWeight: '700', lineHeight: 18 },
})
