import { type ComponentProps, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

import { IpadNativeChromeSurface } from './IpadNativeChromeSurface'
import { type ToolbarAction, type ToolbarState } from './IpadNativeToolbar'
import { IPAD_NATIVE_CHROME_HEIGHT, type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

type OverflowItemProps = {
  active?: boolean
  disabled?: boolean
  icon: MaterialIconName
  label: string
  onPress: () => void
  theme: IpadNativeChromeTheme
}

const OverflowItem = ({
  active = false,
  disabled = false,
  icon,
  label,
  onPress,
  theme,
}: OverflowItemProps): React.JSX.Element => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      styles.item,
      active ? { backgroundColor: theme.activeBackgroundColor } : null,
      pressed && !disabled ? { backgroundColor: theme.pressedBackgroundColor } : null,
      disabled ? styles.disabled : null,
    ]}
  >
    <MaterialIcons color={active ? theme.activeTintColor : theme.inactiveTintColor} name={icon} size={20} />
    <Text style={[styles.itemLabel, { color: theme.inactiveTintColor }]}>{label}</Text>
  </Pressable>
)

type IpadNativeOverflowMenuProps = {
  onSearchPress: () => void
  onToolbarAction: (action: ToolbarAction) => void
  theme: IpadNativeChromeTheme
  toolbarState: ToolbarState
}

export const IpadNativeOverflowMenu = ({
  onSearchPress,
  onToolbarAction,
  theme,
  toolbarState,
}: IpadNativeOverflowMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const closeThen = (action: () => void): void => {
    setOpen(false)
    action()
  }

  return (
    <View style={styles.host}>
      <IpadNativeChromeSurface style={styles.triggerSurface} theme={theme}>
        <Pressable
          accessibilityLabel="More navigation controls"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          style={({ pressed }) => [
            styles.trigger,
            pressed ? { backgroundColor: theme.pressedBackgroundColor } : null,
          ]}
        >
          <MaterialIcons color={theme.inactiveTintColor} name="more-horiz" size={22} />
        </Pressable>
      </IpadNativeChromeSurface>
      {open ? (
        <View style={[styles.menu, { backgroundColor: theme.backgroundColor, borderColor: theme.borderColor }]}>
          <OverflowItem icon="search" label="Search" onPress={() => closeThen(onSearchPress)} theme={theme} />
          <OverflowItem
            disabled={!toolbarState.canBack}
            icon="arrow-back-ios-new"
            label="Back"
            onPress={() => closeThen(() => onToolbarAction('back'))}
            theme={theme}
          />
          <OverflowItem
            disabled={!toolbarState.canForward}
            icon="arrow-forward-ios"
            label="Forward"
            onPress={() => closeThen(() => onToolbarAction('forward'))}
            theme={theme}
          />
          <OverflowItem
            active={toolbarState.recentOpen}
            icon="history"
            label="Recent channels"
            onPress={() => closeThen(() => onToolbarAction('history'))}
            theme={theme}
          />
          <OverflowItem
            icon="help-outline"
            label="Help and feedback"
            onPress={() => closeThen(() => onToolbarAction('help'))}
            theme={theme}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.32 },
  host: { position: 'relative', zIndex: 30 },
  item: {
    alignItems: 'center',
    borderRadius: 11,
    flexDirection: 'row',
    gap: 10,
    height: 38,
    paddingHorizontal: 10,
  },
  itemLabel: { fontSize: 15, fontWeight: '600' },
  menu: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 212,
    padding: 6,
    position: 'absolute',
    right: 0,
    top: IPAD_NATIVE_CHROME_HEIGHT + 8,
  },
  trigger: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  triggerSurface: { justifyContent: 'center', width: IPAD_NATIVE_CHROME_HEIGHT },
})
