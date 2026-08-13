import { type ComponentProps } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

export type ToolbarAction = 'back' | 'forward' | 'history' | 'help'

export type ToolbarState = {
  canBack: boolean
  canForward: boolean
  recentOpen: boolean
}

export const DEFAULT_TOOLBAR_STATE: ToolbarState = {
  canBack: false,
  canForward: false,
  recentOpen: false,
}

type IpadToolbarButtonProps = {
  active?: boolean
  disabled?: boolean
  icon: MaterialIconName
  label: string
  onPress: () => void
  theme: IpadNativeChromeTheme
}

const IpadToolbarButton = ({
  active = false,
  disabled = false,
  icon,
  label,
  onPress,
  theme,
}: IpadToolbarButtonProps): React.JSX.Element => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      styles.button,
      active ? { backgroundColor: theme.activeBackgroundColor } : null,
      disabled ? styles.buttonDisabled : null,
      pressed && !disabled ? { backgroundColor: theme.pressedBackgroundColor } : null,
    ]}
  >
    <MaterialIcons color={active ? theme.activeTintColor : theme.inactiveTintColor} name={icon} size={20} />
  </Pressable>
)

type IpadNativeToolbarProps = ToolbarState & {
  left: number
  onAction: (action: ToolbarAction) => void
  theme: IpadNativeChromeTheme
  top: number
}

export const IpadNativeToolbar = ({
  canBack,
  canForward,
  left,
  onAction,
  recentOpen,
  theme,
  top,
}: IpadNativeToolbarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { left, top }]}>
    <IpadNativeChromeSurface theme={theme}>
      <IpadToolbarButton
        disabled={!canBack}
        icon="arrow-back-ios-new"
        label="Back"
        onPress={() => onAction('back')}
        theme={theme}
      />
      <IpadToolbarButton
        disabled={!canForward}
        icon="arrow-forward-ios"
        label="Forward"
        onPress={() => onAction('forward')}
        theme={theme}
      />
      <IpadToolbarButton
        active={recentOpen}
        icon="history"
        label="Recent channels"
        onPress={() => onAction('history')}
        theme={theme}
      />
      <IpadToolbarButton
        icon="help-outline"
        label="Help and feedback"
        onPress={() => onAction('help')}
        theme={theme}
      />
    </IpadNativeChromeSurface>
  </View>
)

const styles = StyleSheet.create({
  button: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
  },
  buttonDisabled: {
    opacity: 0.28,
  },
  layer: {
    position: 'absolute',
    zIndex: 20,
  },
})
