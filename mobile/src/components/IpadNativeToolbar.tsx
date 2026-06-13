import { type ComponentProps } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

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
}

const IpadToolbarButton = ({
  active = false,
  disabled = false,
  icon,
  label,
  onPress,
}: IpadToolbarButtonProps): React.JSX.Element => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      styles.button,
      active ? styles.buttonActive : null,
      disabled ? styles.buttonDisabled : null,
      pressed && !disabled ? styles.buttonPressed : null,
    ]}
  >
    <MaterialIcons color="#f8fafc" name={icon} size={20} />
  </Pressable>
)

type IpadNativeToolbarProps = ToolbarState & {
  onAction: (action: ToolbarAction) => void
  top: number
}

export const IpadNativeToolbar = ({
  canBack,
  canForward,
  onAction,
  recentOpen,
  top,
}: IpadNativeToolbarProps): React.JSX.Element => (
  <View pointerEvents="box-none" style={[styles.layer, { top }]}>
    <View style={styles.toolbar}>
      <IpadToolbarButton
        disabled={!canBack}
        icon="arrow-back-ios-new"
        label="Back"
        onPress={() => onAction('back')}
      />
      <IpadToolbarButton
        disabled={!canForward}
        icon="arrow-forward-ios"
        label="Forward"
        onPress={() => onAction('forward')}
      />
      <IpadToolbarButton
        active={recentOpen}
        icon="history"
        label="Recent channels"
        onPress={() => onAction('history')}
      />
      <IpadToolbarButton icon="help-outline" label="Help and feedback" onPress={() => onAction('help')} />
    </View>
  </View>
)

const styles = StyleSheet.create({
  button: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  buttonActive: {
    backgroundColor: 'rgba(124, 58, 237, 0.42)',
  },
  buttonDisabled: {
    opacity: 0.28,
  },
  buttonPressed: {
    backgroundColor: 'rgba(248, 250, 252, 0.16)',
  },
  layer: {
    position: 'absolute',
    right: 10,
    zIndex: 20,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    padding: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
  },
})
