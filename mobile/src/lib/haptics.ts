import type { HapticKind, NativeShellMessage } from './native-shell-message'

export type { HapticKind }

export type HapticMessage = NativeShellMessage & {
  haptic: HapticKind
  type: 'nessie:haptic'
}

const HAPTIC_KINDS: ReadonlySet<string> = new Set<HapticKind>([
  'light',
  'medium',
  'heavy',
  'selection',
  'success',
  'warning',
  'error',
])

/** This is a distinct bridge capability, never the generic presentation payload. */
export const isHapticMessage = (message: NativeShellMessage): message is HapticMessage =>
  message.type === 'nessie:haptic'
  && typeof message.haptic === 'string'
  && HAPTIC_KINDS.has(message.haptic)

// expo-haptics groups feedback into three native families. This is the pure
// kind-to-family mapping, kept separate from the actual native call so it is
// testable without loading expo-haptics — whose import graph pulls in
// react-native, which the plain `tsx --test` runner cannot parse outside the
// Metro/babel toolchain that ships with the app.
export type HapticFeedback =
  | { family: 'impact'; style: 'Light' | 'Medium' | 'Heavy' }
  | { family: 'notification'; outcome: 'Success' | 'Warning' | 'Error' }
  | { family: 'selection' }

export const hapticFeedbackFor = (kind: HapticKind): HapticFeedback => {
  switch (kind) {
    case 'light': return { family: 'impact', style: 'Light' }
    case 'medium': return { family: 'impact', style: 'Medium' }
    case 'heavy': return { family: 'impact', style: 'Heavy' }
    case 'selection': return { family: 'selection' }
    case 'success': return { family: 'notification', outcome: 'Success' }
    case 'warning': return { family: 'notification', outcome: 'Warning' }
    case 'error': return { family: 'notification', outcome: 'Error' }
  }
}

// The only place expo-haptics is loaded, and only at call time via a dynamic
// import — never at module scope, so importing this file (as the message
// handler and its tests do) never touches the native module. Unavailable
// haptics (an unsupported device, a native module not yet linked) fail
// silently: a missed buzz is never worth interrupting the gesture it rides on.
export const triggerHaptic = (kind: HapticKind): void => {
  const feedback = hapticFeedbackFor(kind)
  void import('expo-haptics').then((Haptics) => {
    if (feedback.family === 'impact') {
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle[feedback.style])
    }
    if (feedback.family === 'selection') {
      return Haptics.selectionAsync()
    }
    return Haptics.notificationAsync(Haptics.NotificationFeedbackType[feedback.outcome])
  }).catch(() => undefined)
}
