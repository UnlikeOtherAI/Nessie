import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { withOpacity } from '../lib/ipad-native-chrome'
import {
  NATIVE_CREATION_ACTION_SIZE,
  NATIVE_CREATION_OPTIONS,
  nativeCreationMenuMetrics,
  shouldDismissNativeCreationMenu,
  type NativeCreationLane,
} from '../lib/native-creation-menu'
import type { NativeCreationAction } from '../lib/native-shell-layout'

type NativeCreationMenuProps = {
  accentColor: string
  dismissVersion: number
  lane: NativeCreationLane
  onAccentColor: string
  onOpen: () => void
  onSelect: (action: NativeCreationAction) => void
  sheetMutedText: string
  sheetSurface: string
  sheetText: string
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * The creation control every native shell shows on its channels surface: a
 * compose button that morphs into the sheet's Message row as the sheet grows
 * out of it. One component, laid out inside whichever lane it is given, so an
 * iPhone's floating action and an iPad's list column cannot drift apart.
 */
export const NativeCreationMenu = ({
  accentColor,
  dismissVersion,
  lane,
  onAccentColor,
  onOpen,
  onSelect,
  sheetMutedText,
  sheetSurface,
  sheetText,
}: NativeCreationMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const progress = useRef(new Animated.Value(0)).current
  const dismissedVersion = useRef(dismissVersion)
  const { width: windowWidth } = useWindowDimensions()

  const openMenu = (): void => {
    onOpen()
    progress.stopAnimation()
    progress.setValue(0)
    setOpen(true)
    requestAnimationFrame(() => {
      Animated.timing(progress, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: false,
      }).start()
    })
  }

  const closeMenu = useCallback((): void => {
    Animated.timing(progress, {
      duration: 180,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) setOpen(false)
    })
  }, [progress])

  useEffect(() => {
    const shouldClose = shouldDismissNativeCreationMenu({
      creationOpen: open,
      dismissVersion,
      previousDismissVersion: dismissedVersion.current,
    })
    dismissedVersion.current = dismissVersion
    if (shouldClose) closeMenu()
  }, [closeMenu, dismissVersion, open])

  const select = (action: NativeCreationAction): void => {
    progress.stopAnimation()
    progress.setValue(0)
    setOpen(false)
    onSelect(action)
  }

  const metrics = nativeCreationMenuMetrics(lane, windowWidth)
  const sheetAnimation = {
    opacity: progress,
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [116, 0] }) },
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [96, 0] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) },
    ],
  }
  const optionsAnimation = {
    opacity: progress.interpolate({ inputRange: [0, 0.44, 1], outputRange: [0, 0, 1] }),
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) },
    ],
  }

  return (
    <>
      <AnimatedPressable
        accessibilityLabel={open ? 'Start a direct message' : 'Open creation menu'}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => {
          if (open) select('message')
          else openMenu()
        }}
        style={[
          styles.morphingMessageAction,
          {
            backgroundColor: accentColor,
            bottom: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [metrics.collapsedBottom, metrics.expandedBottom],
            }),
            borderRadius: progress.interpolate({ inputRange: [0, 1], outputRange: [31, 16] }),
            height: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [NATIVE_CREATION_ACTION_SIZE, 38],
            }),
            right: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [metrics.collapsedRight, metrics.expandedRight],
            }),
            width: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [NATIVE_CREATION_ACTION_SIZE, metrics.messageActionWidth],
            }),
          },
        ]}
      >
        <Animated.Text
          style={[
            styles.composeSymbol,
            {
              color: onAccentColor,
              opacity: progress.interpolate({ inputRange: [0, 0.52, 1], outputRange: [1, 0, 0] }),
            },
          ]}
        >
          +
        </Animated.Text>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.morphingMessageContent,
            { opacity: progress.interpolate({ inputRange: [0, 0.38, 1], outputRange: [0, 0, 1] }) },
          ]}
        >
          <MaterialIcons color={onAccentColor} name="edit" size={17} />
          <Text style={[styles.messageActionText, { color: onAccentColor }]}>Message</Text>
        </Animated.View>
      </AnimatedPressable>
      {open ? (
        <>
          <Pressable
            accessibilityLabel="Close create menu"
            onPress={closeMenu}
            style={styles.createBackdrop}
          />
          <Animated.View
            accessibilityViewIsModal
            style={[
              styles.createSheet,
              {
                backgroundColor: withOpacity(sheetSurface, 0.98),
                borderColor: withOpacity(sheetText, 0.16),
                bottom: metrics.sheetBottom,
                left: lane.left,
                right: lane.right,
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
                  onPress={() => select(option.action)}
                  style={({ pressed }) => [
                    styles.createRow,
                    pressed ? { backgroundColor: withOpacity(sheetText, 0.07) } : null,
                  ]}
                >
                  <View style={[styles.createIcon, { backgroundColor: withOpacity(accentColor, 0.12) }]}>
                    <MaterialIcons color={accentColor} name={option.icon} size={18} />
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
