import { type ComponentProps } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { type ToolbarAction, type ToolbarState } from './native-toolbar-state'
import { type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

export { type ToolbarAction, type ToolbarState } from './native-toolbar-state'

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

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
  onAction: (action: ToolbarAction) => void
  theme: IpadNativeChromeTheme
}

export const IpadNativeToolbar = ({
  canBack,
  canForward,
  onAction,
  recentOpen,
  theme,
}: IpadNativeToolbarProps): React.JSX.Element => (
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
})
